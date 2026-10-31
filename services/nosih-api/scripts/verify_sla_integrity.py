"""Verify SLA closure/reopen and class-strength revalidation, rolled back."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect, enable_utf8_stdout  # noqa: E402

enable_utf8_stdout()

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
    with connect() as conn:
        cur = conn.cursor()

        def scalar(sql: str, **params):
            cur.execute(sql, params)
            return cur.fetchone()[0]

        def row(sql: str, **params):
            cur.execute(sql, params)
            return cur.fetchone()

        space = scalar(
            "select r.code from public.rooms r where r.visual_state = 'HEALTHY' "
            " and not exists (select 1 from public.complaints c where c.space_code = r.code "
            "                  and c.status not in ('RESOLVED','CLOSED','MERGED_DUPLICATE')) "
            " order by r.code limit 1"
        )
        submitted = scalar(
            "select public.rpc_submit_complaint(cast(%(payload)s as jsonb))",
            payload=json.dumps({
                "email": "facilities@nosih.edu.in",
                "is_anonymous": False,
                "space_code": space,
                "description": "The classroom door hinge is broken and the door will not close.",
                "source_channel": "WEB_PORTAL",
            }),
        )
        complaint_id = submitted["complaint"]["id"]
        wo = row("select id, wo_number from public.work_orders where complaint_id = %(id)s order by id desc limit 1",
                 id=complaint_id)
        clock = row("select id, elapsed_active_mins, is_24x7 from public.sla_clocks "
                    "where target_type = 'WORK_ORDER' and target_id = %(id)s order by id desc limit 1",
                    id=wo[0])
        print(f"ticket {submitted['complaint']['ticket_number']} · {wo[1]} · clock {clock[0]}")

        # A clock accrues operational minutes, not wall-clock minutes: a weekend or a
        # campus holiday contributes nothing, so a ten-minute rewind is not enough to
        # prove accrual. Rewind to the last working day's opening instead, which
        # always contains real operating time whatever the day of the week.
        anchor = scalar(
            "select max(open_at) from ("
            "  select (g.d::date + make_interval(mins => coalesce(c.open_minute, 540))) at time zone 'Asia/Kolkata' as open_at"
            "    from generate_series(current_date - 30, current_date, interval '1 day') g(d)"
            "    left join public.sla_calendar_days c on c.day_date = g.d::date"
            "   where extract(isodow from g.d) between 1 and 5 and coalesce(c.is_working_day, true)"
            ") t where open_at < now()"
        )

        def rewind(clock_id: int) -> float:
            """Rewind the clock to the anchor, clear any pause, return the minutes owed."""
            cur.execute(
                "update public.sla_clocks set last_tick_at = %(anchor)s, is_paused = false where id = %(id)s",
                {"anchor": anchor, "id": clock_id},
            )
            return scalar("select public.nosih_sla_operating_minutes(%(anchor)s, now(), %(x7)s)",
                          anchor=anchor, x7=clock[2])

        owed = rewind(clock[0])
        scalar("select public.rpc_tick_sla_clocks()")
        after_tick = scalar("select elapsed_active_mins from public.sla_clocks where id = %(id)s", id=clock[0])
        check("clock accrues while open", owed > 0 and abs((after_tick - clock[1]) - owed) <= 1,
              (clock[1], after_tick, owed))

        cur.execute(
            "update public.work_orders set status='ASSIGNED', assigned_staff_code="
            "(select staff_code from public.staff_profiles order by staff_code limit 1) where id = %(id)s",
            {"id": wo[0]},
        )
        completed = scalar(
            "select public.rpc_complete_work_order(%(id)s, 'Replaced the hinge and aligned the door', 'facilities@nosih.edu.in')",
            id=wo[0],
        )
        check("work order completes", completed.get("success") is True, completed)

        closed = row(
            "select closed_at, closed_reason, is_paused, elapsed_active_mins from public.sla_clocks where id = %(id)s",
            id=clock[0],
        )
        check("clock closes on completion", closed[0] is not None and closed[1] == "WORK_ORDER_COMPLETED", closed)
        check("closed clock is paused", closed[2] is True, closed[2])

        cur.execute("update public.sla_clocks set last_tick_at = %(anchor)s where id = %(id)s",
                    {"anchor": anchor, "id": clock[0]})
        scalar("select public.rpc_tick_sla_clocks()")
        frozen = scalar("select elapsed_active_mins from public.sla_clocks where id = %(id)s", id=clock[0])
        check("closed clock does not accrue", frozen == closed[3], (closed[3], frozen))

        reopened = scalar(
            "select public.rpc_update_complaint_status(%(id)s, 'OPEN', 'facilities@nosih.edu.in')", id=complaint_id
        )
        check("complaint reopens", reopened.get("status") == "OPEN", reopened.get("status"))
        live = row(
            "select closed_at, is_paused, elapsed_active_mins from public.sla_clocks where id = %(id)s",
            id=clock[0],
        )
        check("clock reopens with the complaint", live[0] is None and live[1] is False, live)

        owed = rewind(clock[0])
        scalar("select public.rpc_tick_sla_clocks()")
        resumed = scalar("select elapsed_active_mins from public.sla_clocks where id = %(id)s", id=clock[0])
        check("reopened clock accrues again", owed > 0 and abs((resumed - live[2]) - owed) <= 1,
              (live[2], resumed, owed))

        resolved = scalar(
            "select public.rpc_update_complaint_status(%(id)s, 'RESOLVED', 'facilities@nosih.edu.in')", id=complaint_id
        )
        check("complaint resolves", resolved.get("status") == "RESOLVED", resolved.get("status"))
        final = row("select closed_at, closed_reason from public.sla_clocks where id = %(id)s", id=clock[0])
        check("resolution closes the clock", final[0] is not None and final[1] == "COMPLAINT_RESOLVED", final)

        # A completion that bypassed the completion RPC is caught by the tick.
        cur.execute(
            "update public.sla_clocks set is_paused=false, closed_at=null, closed_reason=null, "
            "last_tick_at = now() - interval '5 minutes' where id = %(id)s",
            {"id": clock[0]},
        )
        cur.execute("update public.work_orders set status='COMPLETED' where id = %(id)s", {"id": wo[0]})
        scalar("select public.rpc_tick_sla_clocks()")
        defensive = row("select closed_at, closed_reason from public.sla_clocks where id = %(id)s", id=clock[0])
        check("tick closes a finished work order", defensive[0] is not None and defensive[1] == "TARGET_RESOLVED", defensive)

        # Class strength: create a booking first, then raise the class above capacity.
        day = scalar("select (current_date + ((8 - extract(isodow from current_date))::int %% 7))::date")
        free = row(
            "select r.code, g.period_number from public.rooms r "
            "cross join generate_series(1, 6) as g(period_number) "
            "where r.visual_state = 'HEALTHY' "
            "  and jsonb_array_length(public.nosih_booking_conflicts(r.code, "
            "      ((%(day)s)::date + public.nosih_period_start(g.period_number)) at time zone 'Asia/Kolkata', "
            "      ((%(day)s)::date + public.nosih_period_end(g.period_number)) at time zone 'Asia/Kolkata')) = 0 "
            " order by r.code, g.period_number limit 1",
            day=day,
        )
        class_code = scalar("select class_code from public.student_classes where student_strength <= 60 order by class_code limit 1")
        booked = scalar(
            "select public.rpc_create_booking("
            "%(room)s, ((%(day)s)::date + public.nosih_period_start(%(period)s)) at time zone 'Asia/Kolkata', "
            "((%(day)s)::date + public.nosih_period_end(%(period)s)) at time zone 'Asia/Kolkata', "
            "'Strength review booking', %(class_code)s, 'facilities@nosih.edu.in', 'verify-strength')",
            room=free[0], day=str(day), period=free[1], class_code=class_code,
        )
        check("booking exists before the change", booked.get("success") is True, booked)

        changed = scalar(
            "select public.rpc_set_class_strength(%(class_code)s, 200, 'facilities@nosih.edu.in')",
            class_code=class_code,
        )
        check("class strength changes", changed.get("success") is True and changed.get("student_strength") == 200, changed)
        check("timetable conflicts are reported", len(changed.get("timetable_conflicts") or []) > 0, len(changed.get("timetable_conflicts") or []))
        booking_conflicts = changed.get("booking_conflicts") or []
        check("future booking conflicts are reported", any(item.get("booking_id") == booked.get("booking_id") for item in booking_conflicts), booking_conflicts)
        check("change is flagged for review", changed.get("requires_review") is True, changed.get("requires_review"))

        conn.rollback()
        print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            print(json.dumps(FAILED, indent=2))
            sys.exit(1)


if __name__ == "__main__":
    main()
