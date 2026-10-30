"""Verify SLA closure/reopen and class-strength revalidation, rolled back."""

from __future__ import annotations

import json
import sys

from sqlalchemy import text

sys.path.insert(0, ".")

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


def main() -> None:
    with engine.connect() as conn:
        trans = conn.begin()

        def scalar(sql: str, **params):
            return conn.execute(text(sql), params).scalar_one()

        space = scalar(
            "select r.code from public.rooms r where r.visual_state = 'HEALTHY' "
            " and not exists (select 1 from public.complaints c where c.space_code = r.code "
            "                  and c.status not in ('RESOLVED','CLOSED','MERGED_DUPLICATE')) "
            " order by r.code limit 1"
        )
        submitted = scalar(
            "select public.rpc_submit_complaint(cast(:payload as jsonb))",
            payload=json.dumps({
                "email": "facilities@nosih.edu.in",
                "is_anonymous": False,
                "space_code": space,
                "description": "The classroom door hinge is broken and the door will not close.",
                "source_channel": "WEB_PORTAL",
            }),
        )
        complaint_id = submitted["complaint"]["id"]
        wo = conn.execute(
            text("select id, wo_number from public.work_orders where complaint_id = :id order by id desc limit 1"),
            {"id": complaint_id},
        ).one()
        clock = conn.execute(
            text("select id, elapsed_active_mins from public.sla_clocks "
                 "where target_type = 'WORK_ORDER' and target_id = :id order by id desc limit 1"),
            {"id": wo.id},
        ).one()
        print(f"ticket {submitted['complaint']['ticket_number']} · {wo.wo_number} · clock {clock.id}")

        conn.execute(text("update public.sla_clocks set last_tick_at = now() - interval '10 minutes' where id = :id"), {"id": clock.id})
        scalar("select public.rpc_tick_sla_clocks()")
        after_tick = scalar("select elapsed_active_mins from public.sla_clocks where id = :id", id=clock.id)
        check("clock accrues while open", after_tick - clock.elapsed_active_mins >= 9, (clock.elapsed_active_mins, after_tick))

        conn.execute(
            text("update public.work_orders set status='ASSIGNED', assigned_staff_code="
                 "(select staff_code from public.staff_profiles order by staff_code limit 1) where id = :id"),
            {"id": wo.id},
        )
        completed = scalar(
            "select public.rpc_complete_work_order(:id, 'Replaced the hinge and aligned the door', 'facilities@nosih.edu.in')",
            id=wo.id,
        )
        check("work order completes", completed.get("success") is True, completed)

        closed = conn.execute(
            text("select closed_at, closed_reason, is_paused, elapsed_active_mins from public.sla_clocks where id = :id"),
            {"id": clock.id},
        ).one()
        check("clock closes on completion", closed.closed_at is not None and closed.closed_reason == "WORK_ORDER_COMPLETED", closed)
        check("closed clock is paused", closed.is_paused is True, closed.is_paused)

        conn.execute(text("update public.sla_clocks set last_tick_at = now() - interval '10 minutes' where id = :id"), {"id": clock.id})
        scalar("select public.rpc_tick_sla_clocks()")
        frozen = scalar("select elapsed_active_mins from public.sla_clocks where id = :id", id=clock.id)
        check("closed clock does not accrue", frozen == closed.elapsed_active_mins, (closed.elapsed_active_mins, frozen))

        reopened = scalar(
            "select public.rpc_update_complaint_status(:id, 'OPEN', 'facilities@nosih.edu.in')", id=complaint_id
        )
        check("complaint reopens", reopened.get("status") == "OPEN", reopened.get("status"))
        live = conn.execute(
            text("select closed_at, is_paused, elapsed_active_mins from public.sla_clocks where id = :id"),
            {"id": clock.id},
        ).one()
        check("clock reopens with the complaint", live.closed_at is None and live.is_paused is False, live)

        conn.execute(text("update public.sla_clocks set last_tick_at = now() - interval '10 minutes' where id = :id"), {"id": clock.id})
        scalar("select public.rpc_tick_sla_clocks()")
        resumed = scalar("select elapsed_active_mins from public.sla_clocks where id = :id", id=clock.id)
        check("reopened clock accrues again", resumed - live.elapsed_active_mins >= 9, (live.elapsed_active_mins, resumed))

        resolved = scalar(
            "select public.rpc_update_complaint_status(:id, 'RESOLVED', 'facilities@nosih.edu.in')", id=complaint_id
        )
        check("complaint resolves", resolved.get("status") == "RESOLVED", resolved.get("status"))
        final = conn.execute(
            text("select closed_at, closed_reason from public.sla_clocks where id = :id"), {"id": clock.id}
        ).one()
        check("resolution closes the clock", final.closed_at is not None and final.closed_reason == "COMPLAINT_RESOLVED", final)

        # A completion that bypassed the completion RPC is caught by the tick.
        conn.execute(
            text("update public.sla_clocks set is_paused=false, closed_at=null, closed_reason=null, "
                 "last_tick_at = now() - interval '5 minutes' where id = :id"),
            {"id": clock.id},
        )
        conn.execute(text("update public.work_orders set status='COMPLETED' where id = :id"), {"id": wo.id})
        scalar("select public.rpc_tick_sla_clocks()")
        defensive = conn.execute(
            text("select closed_at, closed_reason from public.sla_clocks where id = :id"), {"id": clock.id}
        ).one()
        check("tick closes a finished work order", defensive.closed_at is not None and defensive.closed_reason == "TARGET_RESOLVED", defensive)

        # Class strength: create a booking first, then raise the class above capacity.
        day = scalar("select (current_date + ((8 - extract(isodow from current_date))::int % 7))::date")
        free = conn.execute(
            text(
                "select r.code, g.period_number from public.rooms r "
                "cross join generate_series(1, 6) as g(period_number) "
                "where r.visual_state = 'HEALTHY' "
                "  and jsonb_array_length(public.nosih_booking_conflicts(r.code, "
                "      ((:day)::date + public.nosih_period_start(g.period_number)) at time zone 'Asia/Kolkata', "
                "      ((:day)::date + public.nosih_period_end(g.period_number)) at time zone 'Asia/Kolkata')) = 0 "
                " order by r.code, g.period_number limit 1"
            ),
            {"day": day},
        ).one()
        class_code = scalar("select class_code from public.student_classes where student_strength <= 60 order by class_code limit 1")
        booked = scalar(
            "select public.rpc_create_booking("
            ":room, ((:day)::date + public.nosih_period_start(:period)) at time zone 'Asia/Kolkata', "
            "((:day)::date + public.nosih_period_end(:period)) at time zone 'Asia/Kolkata', "
            "'Strength review booking', :class_code, 'facilities@nosih.edu.in', 'verify-strength')",
            room=free.code, day=str(day), period=free.period_number, class_code=class_code,
        )
        check("booking exists before the change", booked.get("success") is True, booked)

        changed = scalar(
            "select public.rpc_set_class_strength(:class_code, 200, 'facilities@nosih.edu.in')",
            class_code=class_code,
        )
        check("class strength changes", changed.get("success") is True and changed.get("student_strength") == 200, changed)
        check("timetable conflicts are reported", len(changed.get("timetable_conflicts") or []) > 0, len(changed.get("timetable_conflicts") or []))
        booking_conflicts = changed.get("booking_conflicts") or []
        check("future booking conflicts are reported", any(item.get("booking_id") == booked.get("booking_id") for item in booking_conflicts), booking_conflicts)
        check("change is flagged for review", changed.get("requires_review") is True, changed.get("requires_review"))

        trans.rollback()
        print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            print(json.dumps(FAILED, indent=2))
            sys.exit(1)


if __name__ == "__main__":
    main()
