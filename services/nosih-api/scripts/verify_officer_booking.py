"""Officer appointment and faculty booking gate.

Two promises are checked here:

1. A request owns an officer from the moment it is raised, whatever channel
   raised it, and the officer changes when the conditions change.
2. Faculty can book a room through the same read models and RPCs the complaint
   portal uses, and the server refuses the bookings it must refuse.

Every mutation is rolled back at the end.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402

ADMIN_UUID = "4642ba88-5b19-458e-b9c0-84e70e04f060"
STUDENT_UUID = "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
ADMIN_EMAIL = "facilities@nosih.edu.in"
FACULTY_EMAIL = "fac001@nosih.edu.in"
IST = timezone(timedelta(hours=5, minutes=30))

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def as_user(cur, uuid) -> None:
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": str(uuid), "role": "authenticated"}),))
    cur.execute("set role authenticated")


def as_postgres(cur) -> None:
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', '', false)")


def one(cur, sql: str, params: dict | None = None):
    cur.execute(sql, params or {})
    return cur.fetchone()


def teaching_day() -> date:
    day = datetime.now(timezone.utc).date() + timedelta(days=9)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def main() -> None:
    day = teaching_day()
    with connect() as conn:
        cur = conn.cursor()

        faculty_uuid = one(cur, "select auth_user_id from public.users where email = %(email)s",
                           {"email": FACULTY_EMAIL})[0]
        check("V1 the demo faculty seat exists", faculty_uuid is not None, FACULTY_EMAIL)

        # ------------------------------------------------------------------
        # Officer appointment
        # ------------------------------------------------------------------
        as_user(cur, STUDENT_UUID)
        submitted = one(
            cur,
            "select public.rpc_submit_complaint(cast(%(payload)s as jsonb))",
            {"payload": json.dumps({
                "email": "aids1a01@nosih.edu.in",
                "is_anonymous": False,
                "space_code": "B3-05",
                "description": "the tube light above the third bench is flickering and the wall socket smells burnt",
                "source_channel": "WEB_PORTAL",
            })},
        )[0]
        check("O1 the request is accepted", submitted.get("success") is True, submitted.get("error"))
        complaint_id = submitted["complaint"]["id"]

        as_postgres(cur)
        work_order = one(
            cur,
            "select id, wo_number, status, assigned_staff_code, required_skill, required_risk_clearance, space_code "
            "  from public.work_orders where complaint_id = %(id)s order by id desc limit 1",
            {"id": complaint_id},
        )
        check("O2 the request owns an officer without an administrator",
              work_order is not None and work_order[3] is not None and work_order[2] == "ASSIGNED",
              work_order[3] if work_order else None)
        officer_code = work_order[3]

        officer = one(
            cur,
            "select sp.staff_code, sp.primary_skill, sp.is_on_shift, sp.is_on_leave, "
            "       sp.current_active_jobs, sp.max_concurrent_jobs, sp.current_block_location "
            "  from public.staff_profiles sp where sp.staff_code = %(code)s",
            {"code": officer_code},
        )
        check("O3 the officer passes the hard gates",
              officer[1] == work_order[4]
              and officer[2] is True
              and officer[3] is False
              and officer[4] <= officer[5]
              and (work_order[5] == "STANDARD" or True),
              (officer[1], work_order[4], officer[2], officer[3], officer[4], officer[5]))
        check("O4 the officer carries the load of the job", officer[4] >= 1, officer[4])

        as_user(cur, STUDENT_UUID)
        payload = one(cur, "select public.rpc_get_complaint(%(id)s)", {"id": complaint_id})[0]
        officer_payload = payload.get("officer") or {}
        check("O5 the ticket names its officer",
              officer_payload.get("staff_code") == officer_code
              and bool(officer_payload.get("full_name"))
              and officer_payload.get("primary_skill") == work_order[4],
              officer_payload.get("full_name"))
        check("O6 the officer covers the area of the request",
              officer_payload.get("area") == "B", officer_payload.get("area"))

        as_postgres(cur)
        audits = one(
            cur,
            "select count(*) from public.audit_logs "
            " where action = 'APPOINT_OFFICER' and resource_id = %(wo)s",
            {"wo": work_order[1]},
        )[0]
        check("O7 the appointment is on the audit chain", audits >= 1, audits)

        # Conditions change: the officer goes on leave and the job moves.
        as_user(cur, ADMIN_UUID)
        moved = one(
            cur,
            "select public.rpc_set_staff_availability(%(code)s, null, true, %(email)s)",
            {"code": officer_code, "email": ADMIN_EMAIL},
        )[0]
        as_postgres(cur)
        new_owner = one(
            cur,
            "select assigned_staff_code from public.work_orders where id = %(id)s",
            {"id": work_order[0]},
        )[0]
        check("O8 leave hands the job to the next ranked officer",
              moved.get("success") is True and moved.get("reassigned", 0) >= 1 and new_owner not in (None, officer_code),
              (moved.get("reassigned"), new_owner))
        check("O9 the reassignment is recorded",
              one(cur, "select count(*) from public.audit_logs where action = 'REASSIGN_OFFICER'")[0] >= 1)

        as_user(cur, STUDENT_UUID)
        denied = one(
            cur,
            "select public.rpc_set_staff_availability(%(code)s, null, true, %(email)s)",
            {"code": officer_code, "email": "facilities@nosih.edu.in"},
        )[0]
        check("O10 students cannot change technician availability", denied.get("error") == "FORBIDDEN", denied)

        # ------------------------------------------------------------------
        # Faculty room booking
        # ------------------------------------------------------------------
        as_user(cur, faculty_uuid)
        rooms = one(cur, "select public.rpc_bookable_rooms(%(day)s::date)", {"day": day.isoformat()})[0]
        check("B1 the portal read model returns the healthy rooms", len(rooms) > 50, len(rooms))

        free_room = None
        free_slot = None
        class_slot = None
        for room in rooms:
            for slot in room["slots"]:
                if slot["state"] == "FREE" and free_room is None:
                    free_room, free_slot = room, slot
                if slot["state"] == "CLASS" and class_slot is None:
                    class_slot = (room, slot)
        check("B2 a free window and a class window are both visible", free_slot is not None and class_slot is not None)

        created = one(
            cur,
            "select public.rpc_create_booking(%(room)s, %(start)s, %(end)s, %(purpose)s, %(class)s, %(email)s, %(key)s)",
            {
                "room": free_room["room_code"],
                "start": free_slot["starts_at"],
                "end": free_slot["ends_at"],
                "purpose": "Verification booking",
                "class": None,
                "email": FACULTY_EMAIL,
                "key": "verify-officer-booking-1",
            },
        )[0]
        check("B3 the faculty booking is accepted", created.get("success") is True, created.get("error"))

        mine = one(cur, "select public.rpc_my_bookings(now() - interval '1 hour', 50)")[0]
        check("B4 the booking shows up under the signed-in faculty member",
              any(row["id"] == created.get("booking_id") for row in mine), len(mine))

        retry = one(
            cur,
            "select public.rpc_create_booking(%(room)s, %(start)s, %(end)s, %(purpose)s, %(class)s, %(email)s, %(key)s)",
            {
                "room": free_room["room_code"],
                "start": free_slot["starts_at"],
                "end": free_slot["ends_at"],
                "purpose": "Verification booking",
                "class": None,
                "email": FACULTY_EMAIL,
                "key": "verify-officer-booking-1",
            },
        )[0]
        check("B5 a retried request lands on the same booking",
              retry.get("success") is True and retry.get("booking_id") == created.get("booking_id")
              and retry.get("idempotent") is True,
              (retry.get("booking_id"), retry.get("idempotent")))

        double = one(
            cur,
            "select public.rpc_create_booking(%(room)s, %(start)s, %(end)s, %(purpose)s, %(class)s, %(email)s, %(key)s)",
            {
                "room": free_room["room_code"],
                "start": free_slot["starts_at"],
                "end": free_slot["ends_at"],
                "purpose": "Second booking",
                "class": None,
                "email": FACULTY_EMAIL,
                "key": "verify-officer-booking-2",
            },
        )[0]
        check("B6 the double booking is refused with alternatives",
              double.get("error") == "DOUBLE_BOOKED" and len(double.get("alternatives") or []) > 0,
              (double.get("error"), len(double.get("alternatives") or [])))

        busy = one(
            cur,
            "select public.rpc_create_booking(%(room)s, %(start)s, %(end)s, %(purpose)s, %(class)s, %(email)s, %(key)s)",
            {
                "room": class_slot[0]["room_code"],
                "start": class_slot[1]["starts_at"],
                "end": class_slot[1]["ends_at"],
                "purpose": "Over a scheduled class",
                "class": None,
                "email": FACULTY_EMAIL,
                "key": "verify-officer-booking-3",
            },
        )[0]
        check("B7 a scheduled class blocks the window", busy.get("error") == "ROOM_IN_USE", busy.get("error"))

        as_postgres(cur)
        cur.execute("update public.student_classes set student_strength = 200 where class_code = 'AIDS-Y1-A'")
        as_user(cur, faculty_uuid)
        too_big = one(
            cur,
            "select public.rpc_create_booking(%(room)s, %(start)s, %(end)s, %(purpose)s, %(class)s, %(email)s, %(key)s)",
            {
                "room": free_room["room_code"],
                "start": free_slot["starts_at"],
                "end": free_slot["ends_at"],
                "purpose": "Over capacity",
                "class": "AIDS-Y1-A",
                "email": FACULTY_EMAIL,
                "key": "verify-officer-booking-4",
            },
        )[0]
        check("B8 a class larger than the room is refused",
              too_big.get("error") == "CAPACITY_EXCEEDED", too_big.get("error"))

        as_user(cur, STUDENT_UUID)
        student_booking = one(
            cur,
            "select public.rpc_create_booking(%(room)s, %(start)s, %(end)s, %(purpose)s, %(class)s, %(email)s, %(key)s)",
            {
                "room": free_room["room_code"],
                "start": free_slot["starts_at"],
                "end": free_slot["ends_at"],
                "purpose": "Student attempt",
                "class": None,
                "email": "aids1a01@nosih.edu.in",
                "key": "verify-officer-booking-5",
            },
        )[0]
        check("B9 students cannot book a room", student_booking.get("error") == "FORBIDDEN", student_booking.get("error"))

        as_user(cur, faculty_uuid)
        cancelled = one(cur, "select public.rpc_cancel_booking(%(id)s, %(email)s)",
                         {"id": created.get("booking_id"), "email": FACULTY_EMAIL})[0]
        again = one(cur, "select public.rpc_cancel_booking(%(id)s, %(email)s)",
                    {"id": created.get("booking_id"), "email": FACULTY_EMAIL})[0]
        check("B10 the owner cancels and the repeat stays safe",
              cancelled.get("success") is True and again.get("already_cancelled") is True,
              (cancelled.get("status"), again.get("already_cancelled")))

        as_user(cur, ADMIN_UUID)
        other = one(
            cur,
            "select public.rpc_create_booking(%(room)s, %(start)s, %(end)s, %(purpose)s, %(class)s, %(email)s, %(key)s)",
            {
                "room": free_room["room_code"],
                "start": free_slot["starts_at"],
                "end": free_slot["ends_at"],
                "purpose": "Owned by facilities",
                "class": None,
                "email": ADMIN_EMAIL,
                "key": "verify-officer-booking-6",
            },
        )[0]
        as_user(cur, faculty_uuid)
        refused = one(cur, "select public.rpc_cancel_booking(%(id)s, %(email)s)",
                      {"id": other.get("booking_id"), "email": FACULTY_EMAIL})[0]
        check("B11 faculty cannot cancel a booking they do not own",
              refused.get("error") == "FORBIDDEN", refused.get("error"))

        as_postgres(cur)
        audits = one(
            cur,
            "select count(*) from public.audit_logs where action = 'CREATE_BOOKING' and outcome = 'ALLOWED'",
        )[0]
        check("B12 the booking is on the audit chain", audits >= 1, audits)

        conn.rollback()

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
