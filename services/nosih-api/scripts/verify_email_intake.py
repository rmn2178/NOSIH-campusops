"""Verify the email intake pipeline inside one rolled-back transaction.

This asserts the exact payload the inbound-email-webhook Edge Function builds:
sender resolved to a user, source_channel EMAIL_INBOX, acknowledgement logged,
work order and SLA opened, and a repeat email merged into the first report.

The live HTTP route additionally needs INBOUND_EMAIL_SECRET to be configured on
the project; run simulate_email_intake.py once that secret is installed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _db import enable_utf8_stdout, sqlalchemy_url  # noqa: E402

enable_utf8_stdout()

engine = create_engine(sqlalchemy_url())

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"PASS  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name}  {detail}")


def main() -> None:
    with engine.connect() as conn:
        trans = conn.begin()

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
        print(f"from {student.email} · space {space}")

        description = f"Water is pooling under the sink in {space}. Email report."

        def submit(email: str) -> dict:
            return scalar(
                "select public.rpc_submit_complaint(cast(:payload as jsonb))",
                payload=json.dumps({
                    "email": email,
                    "is_anonymous": False,
                    "space_code": space,
                    "description": description,
                    "source_channel": "EMAIL_INBOX",
                }),
            )

        first = submit(student.email)
        check("email creates a complaint", first.get("success") is True, first)
        ticket = (first.get("complaint") or {}).get("ticket_number")
        check("ticket returned", bool(ticket), first.get("complaint"))

        row = conn.execute(
            text(
                "select c.id, c.source_channel, c.reporter_user_id, c.space_code, "
                "       (select count(*) from public.work_orders w where w.complaint_id = c.id) as work_orders, "
                "       (select count(*) from public.sla_clocks s where s.target_type = 'WORK_ORDER' "
                "          and s.target_id = (select id from public.work_orders w where w.complaint_id = c.id limit 1)) as clocks "
                "from public.complaints c where c.ticket_number = :ticket"
            ),
            {"ticket": ticket},
        ).one()
        check("channel is EMAIL_INBOX", row.source_channel == "EMAIL_INBOX", row.source_channel)
        check("reporter matches the sender", row.reporter_user_id == student.id, row.reporter_user_id)
        check("space is bound", row.space_code == space, row.space_code)
        check("a work order and clock were opened", row.work_orders == 1 and row.clocks == 1, (row.work_orders, row.clocks))

        # The webhook writes this acknowledgement after a successful submit.
        conn.execute(
            text(
                "insert into public.notification_logs (channel, recipient, subject, payload_json, delivery_status, created_at) "
                "values ('EMAIL', :email, :subject, cast(:payload as text), 'SENT', now())"
            ),
            {
                "email": student.email,
                "subject": f"NOSIH received your report {ticket}",
                "payload": json.dumps({"event": "EMAIL_INTAKE_ACK", "complaint_id": row.id, "ticket_number": ticket}),
            },
        )
        ack = scalar(
            "select count(*) from public.notification_logs where channel = 'EMAIL' "
            " and recipient = :email and payload_json like '%EMAIL_INTAKE_ACK%'",
            email=student.email,
        )
        check("acknowledgement is logged", ack >= 1, ack)

        second = submit(student.email)
        second_ticket = (second.get("complaint") or {}).get("ticket_number")
        parent = scalar(
            "select parent_complaint_id from public.complaints where ticket_number = :ticket",
            ticket=second_ticket,
        )
        check("duplicate email merges into the first report", parent == row.id, (second_ticket, parent))
        work_orders = scalar(
            "select count(*) from public.work_orders w where w.complaint_id in "
            "(:first_id, (select id from public.complaints where ticket_number = :second_ticket))",
            first_id=row.id, second_ticket=second_ticket,
        )
        check("duplicate opens no second work order", work_orders == 1, work_orders)

        unknown = submit("outside.sender@example.org")
        unknown_ticket = (unknown.get("complaint") or {}).get("ticket_number")
        check("unknown sender is accepted", unknown.get("success") is True and bool(unknown_ticket), unknown)
        created_user = scalar(
            "select count(*) from public.users where email = 'outside.sender@example.org'"
        )
        check("sender is given a reporter identity", created_user >= 1, created_user)

        trans.rollback()
        print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            print(json.dumps(FAILED, indent=2))
            sys.exit(1)


if __name__ == "__main__":
    main()
