"""Verify the chat intake contract inside one rolled-back transaction."""

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

        def set_claims(claims: dict | None) -> None:
            conn.execute(
                text("select set_config('request.jwt.claims', :claims, false)"),
                {"claims": json.dumps(claims or {})},
            )

        student = conn.execute(
            text(
                "select u.id, u.email, u.auth_user_id, sc.home_room_code "
                "from public.users u join public.student_classes sc on sc.class_code = u.class_code "
                "where u.role = 'STUDENT' and u.auth_user_id is not null "
                "  and sc.home_room_code is not null "
                "  and u.email <> 'student@nosih.edu.in' "
                "order by u.id limit 1"
            )
        ).one()
        set_claims({"sub": str(student.auth_user_id), "role": "authenticated"})
        print(f"student: {student.email} · home {student.home_room_code}")

        draft = scalar(
            "select public.rpc_chat_intake(cast(:messages as jsonb), 'COMPLAINT', null, false)",
            messages=json.dumps([{"role": "user", "content": "The ceiling fan in B2-04 is sparking and smoking during the lecture"}]),
        )
        check("draft extracts the named room", draft.get("mode") == "DRAFT" and draft.get("space_code") == "B2-04", draft)
        check("draft carries category and urgency", bool(draft.get("category")) and draft.get("urgency") in ("HIGH", "CRITICAL"), draft)

        no_room = scalar(
            "select public.rpc_chat_intake(cast(:messages as jsonb), 'COMPLAINT', null, false)",
            messages=json.dumps([{"role": "user", "content": "Water is leaking near the stairs, it is getting worse"}]),
        )
        check("missing room stays unresolved", no_room.get("space_code") in (None, ""), no_room.get("space_code"))
        suggestions = [item.get("space_code") for item in (no_room.get("suggestions") or [])]
        check("home room is suggested", student.home_room_code in suggestions, suggestions)

        blocked = scalar(
            "select public.rpc_chat_intake(cast(:messages as jsonb), 'COMPLAINT', null, true)",
            messages=json.dumps([{"role": "user", "content": "Water is leaking near the stairs, it is getting worse"}]),
        )
        check("confirm without a space is refused", blocked.get("error") == "SPACE_REQUIRED", blocked)

        test_space = scalar(
            "select r.code from public.rooms r where r.visual_state = 'HEALTHY' "
            " and not exists (select 1 from public.complaints c where c.space_code = r.code "
            "                  and c.created_at > now() - interval '24 hours') "
            " order by r.code limit 1"
        )
        print(f"clean space: {test_space}")
        message = f"The ceiling fan in {test_space} is sparking and smoking during the lecture"

        created = scalar(
            "select public.rpc_chat_intake(cast(:messages as jsonb), 'COMPLAINT', :space, true)",
            messages=json.dumps([{"role": "user", "content": message}]), space=test_space,
        )
        check("confirm creates the complaint", created.get("success") is True and created.get("mode") == "CREATED", created)
        check("ticket number returned", bool(created.get("ticket_number")), created.get("ticket_number"))
        check("work order returned", bool(created.get("work_order_number")), created.get("work_order_number"))

        row = conn.execute(
            text(
                "select c.id, c.source_channel, c.reporter_user_id, c.space_code, "
                "       (select count(*) from public.work_orders w where w.complaint_id = c.id) as work_orders, "
                "       (select count(*) from public.sla_clocks s where s.target_type = 'WORK_ORDER' "
                "          and s.target_id = (select id from public.work_orders w where w.complaint_id = c.id order by id desc limit 1)) as clocks "
                "from public.complaints c where c.ticket_number = :ticket"
            ),
            {"ticket": created.get("ticket_number")},
        ).one()
        check("channel is CHAT", row.source_channel == "CHAT", row.source_channel)
        check("reporter is the signed-in student", row.reporter_user_id == student.id, (row.reporter_user_id, student.id))
        check("space is bound to the ticket", row.space_code == test_space, row.space_code)
        check("a work order and clock were opened", row.work_orders == 1 and row.clocks == 1, (row.work_orders, row.clocks))

        duplicate = scalar(
            "select public.rpc_chat_intake(cast(:messages as jsonb), 'COMPLAINT', :space, true)",
            messages=json.dumps([{"role": "user", "content": message}]), space=test_space,
        )
        check("duplicate reports the original ticket",
              duplicate.get("merged_into") == created.get("ticket_number")
              or duplicate.get("ticket_number") == created.get("ticket_number"),
              duplicate)
        linked = conn.execute(
            text(
                "select c.parent_complaint_id, "
                "       (select count(*) from public.work_orders w where w.complaint_id in (:first_id, c.id)) as work_orders "
                "from public.complaints c where c.ticket_number = :ticket"
            ),
            {"ticket": duplicate.get("ticket_number"), "first_id": row.id},
        ).one()
        check("duplicate is linked to the original complaint", linked.parent_complaint_id == row.id, linked)
        check("duplicate opens no second work order", linked.work_orders == 1, linked.work_orders)

        set_claims({})
        anonymous = scalar(
            "select public.rpc_chat_intake(cast(:messages as jsonb), 'COMPLAINT', 'B2-04', false)",
            messages=json.dumps([{"role": "user", "content": "fan sparking in B2-04"}]),
        )
        check("unauthenticated intake is refused", anonymous.get("error") == "SIGN_IN_REQUIRED", anonymous)

        trans.rollback()
        print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            print(json.dumps(FAILED, indent=2))
            sys.exit(1)


if __name__ == "__main__":
    main()
