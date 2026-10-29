"""Verify the ten platform tasks end to end. Every mutation is rolled back."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

STUDENT = "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
ADMIN = "4642ba88-5b19-458e-b9c0-84e70e04f060"

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def as_user(cur, uuid: str) -> None:
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": uuid, "role": "authenticated"}),))
    cur.execute("set role authenticated")


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        cur = conn.cursor()

        cur.execute("select count(*) from public.notification_logs")
        check("10.2 SLA notifications generated", cur.fetchone()[0] > 0)
        cur.execute("select (public.rpc_timetable_validate()->>'valid')::boolean")
        check("10.3 timetable valid", cur.fetchone()[0] is True)
        cur.execute("select count(*) from cron.job where jobname = 'nosih-clock-tick'")
        check("10.4 live clock cron scheduled", cur.fetchone()[0] == 1)

        as_user(cur, STUDENT)
        cur.execute("select public.nosih_actor_role('facilities@nosih.edu.in')")
        check("2.1 forged email ignored", cur.fetchone()[0] == "STUDENT")
        cur.execute("select id from public.purchase_requests where status = 'PENDING_APPROVAL' limit 1")
        cur.execute("set role postgres")
        cur.execute("select id from public.purchase_requests where status = 'PENDING_APPROVAL' limit 1")
        pr = cur.fetchone()[0]
        as_user(cur, STUDENT)
        cur.execute("select public.rpc_decide_purchase_request(%s,'APPROVE',null,'facilities@nosih.edu.in','FACILITIES_ADMIN',false,null,null)", (pr,))
        res = cur.fetchone()[0]
        check("2.2 separation of duties enforced", res.get("error") == "FORBIDDEN", res)

        cur.execute("set role postgres")
        cur.execute("select code from public.rooms where visual_state = 'HEALTHY' order by code limit 1")
        room = cur.fetchone()[0]
        as_user(cur, ADMIN)
        cur.execute("select public.rpc_create_booking(%s, now() + interval '1 day', now() + interval '1 day 1 hour', 'Exam seating', 'CSE-Y2-B', null)", (room,))
        first = cur.fetchone()[0]
        check("3.1 booking created", first.get("success") is True, first.get("booking_id"))
        cur.execute("select public.rpc_create_booking(%s, now() + interval '1 day 30 minutes', now() + interval '1 day 90 minutes', 'Overlap', null, null)", (room,))
        second = cur.fetchone()[0]
        check("3.2 double booking rejected by constraint", second.get("error") == "DOUBLE_BOOKED", second.get("error"))
        check("3.3 alternatives offered", len(second.get("alternatives") or []) > 0, len(second.get("alternatives") or []))
        cur.execute("select public.rpc_cancel_booking(%s, null)", (first["booking_id"],))
        check("3.4 booking cancellation", cur.fetchone()[0].get("success") is True)

        cur.execute("select public.rpc_analytics_overview(30)")
        analytics = cur.fetchone()[0]
        check("5.1 analytics returns every section",
              all(k in analytics for k in ("open_requests", "sla", "utilisation", "shortages", "recurring_faults", "procurement")),
              list(analytics)[:6])
        check("5.2 analytics values are live", analytics["open_requests"] > 0 and analytics["sla"]["active_clocks"] > 0,
              (analytics["open_requests"], analytics["sla"]))

        as_user(cur, STUDENT)
        cur.execute("select public.rpc_chat_intake(%s::jsonb, 'COMPLAINT', null, false)",
                    (json.dumps([{"role": "user", "content": "fan number 2 in B2-04 is sparking badly during the lecture"}]),))
        draft = cur.fetchone()[0]
        check("4.1 chat draft produced", draft.get("mode") == "DRAFT" and bool(draft.get("summary")), draft.get("space_code"))
        check("4.2 chat draft recognises a safety hazard", draft.get("urgency") == "CRITICAL", draft.get("urgency"))

        as_user(cur, ADMIN)
        cur.execute("set role postgres")
        cur.execute("select id from public.work_orders where status = 'IN_PROGRESS' order by id limit 1")
        wo = cur.fetchone()[0]
        as_user(cur, ADMIN)
        cur.execute("select public.rpc_complete_work_order(%s, 'Verified repair with replacement fan', null)", (wo,))
        check("8.1 completion accepted for an active work order", cur.fetchone()[0].get("success") is True)
        cur.execute("select public.rpc_complete_work_order(%s, 'second attempt', null)", (wo,))
        repeat = cur.fetchone()[0]
        check("8.2 repeated completion rejected", repeat.get("error") == "INVALID_TRANSITION", repeat)

        cur.execute("set role postgres")
        cur.execute("insert into public.users (email, full_name, role, department_code, is_active) values ('dm-test@nosih.edu.in','DM Test','DEPARTMENT_MANAGER','CSE',true) returning id")
        check("9.1 Department Manager role accepted", cur.fetchone()[0] is not None)
        cur.execute("select role from public.users where email = 'dm-test@nosih.edu.in'")
        check("9.2 Department Manager stored", cur.fetchone()[0] == "DEPARTMENT_MANAGER")

        conn.rollback()

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
