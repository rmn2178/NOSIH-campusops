"""Post a realistic email into the inbound webhook and assert the pipeline.

The webhook is a deployed Edge Function with verify_jwt disabled, guarded by
x-nosih-secret. This script reads the secret from the environment, never prints
it, and leaves one attributed EMAIL_INBOX complaint as demo evidence.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from app.database import engine  # noqa: E402

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"PASS  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name}  {detail}")


def post_email(payload: dict) -> tuple[int, dict]:
    if not settings.supabase_url or not settings.inbound_email_secret:
        raise SystemExit("SUPABASE_URL and INBOUND_EMAIL_SECRET are required")
    request = urllib.request.Request(
        f"{settings.supabase_url.rstrip('/')}/functions/v1/inbound-email-webhook",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-nosih-secret": settings.inbound_email_secret,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.status, json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return error.code, {"error": body[:400]}


def main() -> None:
    if not settings.inbound_email_secret:
        print("SKIP live webhook: INBOUND_EMAIL_SECRET is not configured for this project.")
        print("The email pipeline itself is verified by verify_email_intake.py.")
        return

    with engine.connect() as conn:
        def scalar(sql: str, **params):
            return conn.execute(text(sql), params).scalar_one()

        student = conn.execute(
            text(
                "select u.id, u.email from public.users u "
                "where u.role = 'STUDENT' and u.auth_user_id is not null "
                "order by u.id limit 1"
            )
        ).one()
        space = scalar(
            "select r.code from public.rooms r where r.visual_state = 'HEALTHY' "
            " and not exists (select 1 from public.complaints c where c.space_code = r.code "
            "                  and c.created_at > now() - interval '24 hours') "
            " order by r.code limit 1"
        )
        marker = scalar("select substr(md5(random()::text), 1, 8)")
        description = f"Water is pooling under the sink in {space}. Email report {marker}."
        payload = {
            "from_email": student.email,
            "subject": f"Water leak in {space}",
            "body": description,
            "space_code": space,
        }
        print(f"from {student.email} · space {space} · marker {marker}")

        status, data = post_email(payload)
        check("webhook accepts the email", status == 200 and bool(data.get("success")), (status, data))
        ticket = data.get("ticket_number")
        check("webhook returns a ticket", bool(ticket), data)
        if not ticket:
            raise SystemExit(1)

        row = conn.execute(
            text(
                "select c.id, c.source_channel, c.reporter_user_id, c.space_code, "
                "       (select count(*) from public.work_orders w where w.complaint_id = c.id) as work_orders "
                "from public.complaints c where c.ticket_number = :ticket"
            ),
            {"ticket": ticket},
        ).one()
        check("channel is EMAIL_INBOX", row.source_channel == "EMAIL_INBOX", row.source_channel)
        check("reporter matches the sender", row.reporter_user_id == student.id, row.reporter_user_id)
        check("space is bound", row.space_code == space, row.space_code)
        check("email opens a work order", row.work_orders == 1, row.work_orders)

        ack = scalar(
            "select count(*) from public.notification_logs "
            " where channel = 'EMAIL' and recipient = :email "
            "   and payload_json like '%EMAIL_INTAKE_ACK%' "
            "   and payload_json like :ticket",
            email=student.email, ticket=f"%{ticket}%",
        )
        check("acknowledgement is logged", ack >= 1, ack)

        status_two, data_two = post_email(payload)
        check("duplicate email is accepted", status_two == 200 and bool(data_two.get("success")), (status_two, data_two))
        second_ticket = data_two.get("ticket_number")
        linked = conn.execute(
            text("select parent_complaint_id from public.complaints where ticket_number = :ticket"),
            {"ticket": second_ticket},
        ).scalar_one() if second_ticket else None
        check("duplicate email merges into the first report", linked == row.id, (second_ticket, linked))

        request = urllib.request.Request(
            f"{settings.supabase_url.rstrip('/')}/functions/v1/inbound-email-webhook",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "x-nosih-secret": "wrong-secret"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                wrong_status = response.status
        except urllib.error.HTTPError as error:
            wrong_status = error.code
        check("wrong secret is rejected", wrong_status in (401, 403), wrong_status)

        print(f"\nEMAIL EVIDENCE: {ticket} · {space} · {student.email}")
        print(f"{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            print(json.dumps(FAILED, indent=2))
            sys.exit(1)


if __name__ == "__main__":
    main()
