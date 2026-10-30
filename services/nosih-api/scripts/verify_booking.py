"""Verify the booking workspace contract inside one rolled-back transaction.

Checks the gates a reviewer will probe: real timetable/exam occupancy, capacity,
ownership, idempotent retries and the storage-level overlap constraint.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import engine  # noqa: E402
from _db import enable_utf8_stdout  # noqa: E402

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
    with engine.connect() as conn:
        trans = conn.begin()

        def scalar(sql: str, **params):
            return conn.execute(text(sql), params).scalar_one()

        # Next Monday: a deterministic weekday with a real timetable.
        day = scalar("select (current_date + ((8 - extract(isodow from current_date))::int % 7))::date")
        print(f"window day: {day}")

        free = conn.execute(
            text(
                "select r.code, g.period_number "
                "from public.rooms r cross join generate_series(1, 6) as g(period_number) "
                "where r.visual_state = 'HEALTHY' "
                "  and jsonb_array_length(public.nosih_booking_conflicts(r.code, "
                "      ((:day)::date + public.nosih_period_start(g.period_number)) at time zone 'Asia/Kolkata', "
                "      ((:day)::date + public.nosih_period_end(g.period_number)) at time zone 'Asia/Kolkata')) = 0 "
                "order by r.code, g.period_number limit 1"
            ),
            {"day": day},
        ).one()
        room, period = free.code, free.period_number
        print(f"free slot: {room} P{period}")

        creates = lambda **kw: scalar(
            "select public.rpc_create_booking("
            ":room, ((:day)::date + public.nosih_period_start(:period)) at time zone 'Asia/Kolkata', "
            "((:day)::date + public.nosih_period_end(:period)) at time zone 'Asia/Kolkata', "
            ":purpose, :class_code, :email, :key)",
            room=room, day=str(day), period=period, purpose="Department review",
            class_code=kw.get("class_code"), email=kw.get("email", "facilities@nosih.edu.in"),
            key=kw.get("key"),
        )

        first = creates(key="verify-booking-1")
        check("free slot books", first.get("success") is True, first)
        booking_id = first.get("booking_id")

        retry = creates(key="verify-booking-1")
        check("same request key is idempotent", retry.get("idempotent") is True and retry.get("booking_id") == booking_id, retry)

        clash = creates(key="verify-booking-2")
        check("double booking is rejected", clash.get("error") == "DOUBLE_BOOKED", clash)
        check("double booking returns alternatives", len(clash.get("alternatives", [])) > 0, clash.get("alternatives"))

        occupancy = scalar(
            "select public.rpc_get_room_occupancy(:room, "
            "((:day)::date + public.nosih_period_start(:period)) at time zone 'Asia/Kolkata', "
            "((:day)::date + public.nosih_period_end(:period)) at time zone 'Asia/Kolkata')",
            room=room, day=str(day), period=period,
        )
        check("occupancy exposes the booking", any(c.get("kind") == "BOOKING" for c in occupancy.get("conflicts", [])), occupancy.get("conflicts"))

        # A real class in session must block a booking even with no booking row.
        class_slot = conn.execute(
            text(
                "select ts.effective_space_code as room, ts.period_number "
                "from public.timetable_slots ts join public.rooms r on r.code = ts.effective_space_code "
                "where ts.day_of_week = :day_code and r.visual_state = 'HEALTHY' "
                "order by ts.period_number limit 1"
            ),
            {"day_code": "MON"},
        ).first()
        if class_slot:
            class_result = scalar(
                "select public.rpc_create_booking("
                ":room, ((:day)::date + public.nosih_period_start(:period)) at time zone 'Asia/Kolkata', "
                "((:day)::date + public.nosih_period_end(:period)) at time zone 'Asia/Kolkata', "
                "'Class clash probe', null, 'facilities@nosih.edu.in', 'verify-booking-class')",
                room=class_slot.room, day=str(day), period=class_slot.period_number,
            )
            kinds = {c.get("kind") for c in class_result.get("conflicts", [])}
            check("scheduled class blocks the booking", class_result.get("error") == "ROOM_IN_USE" and "CLASS" in kinds, class_result)
        else:
            check("scheduled class blocks the booking", False, "no healthy class slot found")

        # Class strength above room capacity. The seed is sized sensibly, so the
        # transaction temporarily inflates one class to prove the gate fires.
        capacity_row = conn.execute(
            text(
                "select (select code from public.rooms where visual_state = 'HEALTHY' order by capacity asc limit 1) as room, "
                "       (select capacity from public.rooms where visual_state = 'HEALTHY' order by capacity asc limit 1) as capacity, "
                "       (select class_code from public.student_classes order by class_code limit 1) as class_code"
            )
        ).one()
        conn.execute(
            text("update public.student_classes set student_strength = :s where class_code = :c"),
            {"s": capacity_row.capacity + 10, "c": capacity_row.class_code},
        )
        capacity_result = scalar(
            "select public.rpc_create_booking("
            ":room, ((:day)::date + public.nosih_period_start(2)) at time zone 'Asia/Kolkata', "
            "((:day)::date + public.nosih_period_end(2)) at time zone 'Asia/Kolkata', "
            "'Capacity probe', :class_code, 'facilities@nosih.edu.in', 'verify-booking-capacity')",
            room=capacity_row.room, day=str(day), class_code=capacity_row.class_code,
        )
        check("over-capacity class is rejected", capacity_result.get("error") == "CAPACITY_EXCEEDED", capacity_result)

        # Ownership: an incident manager cannot cancel someone else's booking.
        foreign_cancel = scalar(
            "select public.rpc_cancel_booking(:id, 'incident@nosih.edu.in')", id=booking_id
        )
        check("foreign cancel is forbidden", foreign_cancel.get("success") is False and foreign_cancel.get("error") == "FORBIDDEN", foreign_cancel)

        owner_cancel = scalar(
            "select public.rpc_cancel_booking(:id, 'facilities@nosih.edu.in')", id=booking_id
        )
        check("owner cancels the booking", owner_cancel.get("success") is True and owner_cancel.get("status") == "CANCELLED", owner_cancel)

        again = scalar(
            "select public.rpc_cancel_booking(:id, 'facilities@nosih.edu.in')", id=booking_id
        )
        check("repeat cancel is idempotent", again.get("already_cancelled") is True, again)

        # Unhealthy rooms cannot be booked.
        faulty_room = scalar(
            "select code from public.rooms where visual_state = 'HEALTHY' order by code desc limit 1"
        )
        conn.execute(text("update public.rooms set visual_state='FAULTY' where code = :r"), {"r": faulty_room})
        unhealthy = scalar(
            "select public.rpc_create_booking("
            ":room, ((:day)::date + public.nosih_period_start(5)) at time zone 'Asia/Kolkata', "
            "((:day)::date + public.nosih_period_end(5)) at time zone 'Asia/Kolkata', "
            "'Faulty room probe', null, 'facilities@nosih.edu.in', 'verify-booking-faulty')",
            room=faulty_room, day=str(day),
        )
        check("faulty room is rejected", unhealthy.get("error") == "ROOM_NOT_HEALTHY", unhealthy)

        # The exclusion constraint must still stop a direct overlapping insert.
        fresh = creates(key="verify-booking-direct")
        check("slot rebooks after cancellation", fresh.get("success") is True, fresh)
        overlap_blocked = False
        try:
            with conn.begin_nested():
                conn.execute(
                    text(
                        "insert into public.room_bookings (space_code, purpose, starts_at, ends_at) "
                        "values (:room, 'Direct overlap probe', "
                        "((:day)::date + public.nosih_period_start(:period)) at time zone 'Asia/Kolkata', "
                        "((:day)::date + public.nosih_period_end(:period)) at time zone 'Asia/Kolkata')"
                    ),
                    {"room": room, "day": str(day), "period": period},
                )
        except DBAPIError:
            overlap_blocked = True
        check("storage overlap constraint holds", overlap_blocked)

        audit_rows = scalar(
            "select count(*) from public.audit_logs where action in ('CREATE_BOOKING','CANCEL_BOOKING') "
            "and resource_type = 'ROOM'"
        )
        check("booking actions are audited", audit_rows >= 4, audit_rows)

        trans.rollback()
        print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            print(json.dumps(FAILED, indent=2))
            sys.exit(1)


if __name__ == "__main__":
    main()
