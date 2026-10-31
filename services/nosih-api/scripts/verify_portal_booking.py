"""Prove the faculty path over the same HTTP contract the browser uses.

Signs in as the seeded faculty account, reads the room calendar, books a free
window, and reads the complaint feed to confirm every live ticket carries its
area officer. Nothing is written outside the booking it creates, and that
booking is cancelled again before the script exits.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

FACULTY_EMAIL = "fac001@nosih.edu.in"
DEMO_PASSWORD = "Nosih@2026"
IST = timezone(timedelta(hours=5, minutes=30))

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def call(path: str, *, token: str | None = None, payload: dict | None = None) -> tuple[int, object]:
    headers = {"apikey": settings.supabase_publishable_key or "", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{settings.supabase_url}{path}",
        data=data,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, body


def teaching_day() -> str:
    """Monday of next week: the week the campus timetable and the seeded
    faculty bookings cover."""
    today = datetime.now(timezone.utc).date()
    return (today - timedelta(days=today.weekday()) + timedelta(days=7)).isoformat()


def main() -> None:
    status, session = call(
        "/auth/v1/token?grant_type=password",
        payload={"email": FACULTY_EMAIL, "password": DEMO_PASSWORD},
    )
    if status != 200 or not isinstance(session, dict):
        raise SystemExit(f"faculty sign-in failed: {status} {session}")
    token = session["access_token"]
    print(f"signed in: {session['user']['email']}")

    profile = call("/rest/v1/rpc/rpc_my_profile", token=token, payload={})[1]
    check("H1 the faculty profile resolves", isinstance(profile, dict) and profile.get("role") == "FACULTY",
          profile.get("role") if isinstance(profile, dict) else profile)

    day = teaching_day()
    status, rooms = call("/rest/v1/rpc/rpc_bookable_rooms", token=token, payload={"p_date": day})
    check("H2 the room calendar answers for the teaching day", status == 200 and isinstance(rooms, list) and len(rooms) > 50,
          len(rooms) if isinstance(rooms, list) else rooms)

    free = None
    for room in rooms:
        for slot in room["slots"]:
            if slot["state"] == "FREE":
                free = (room, slot)
                break
        if free:
            break
    check("H3 a free window is offered", free is not None)

    booked_rooms = [room for room in rooms if any(slot["state"] == "BOOKING" for slot in room["slots"])]
    check("H4 the calendar already carries campus bookings", len(booked_rooms) > 0, len(booked_rooms))

    status, mine = call("/rest/v1/rpc/rpc_my_bookings", token=token,
                        payload={"p_from": datetime.now(timezone.utc).isoformat(), "p_limit": 50})
    check("H5 the faculty member sees their own bookings",
          status == 200 and isinstance(mine, list) and len(mine) > 0,
          [row.get("purpose") for row in mine] if isinstance(mine, list) else mine)

    status, created = call("/rest/v1/rpc/rpc_create_booking", token=token, payload={
        "p_space_code": free[0]["room_code"],
        "p_starts_at": free[1]["starts_at"],
        "p_ends_at": free[1]["ends_at"],
        "p_purpose": "Portal contract check",
        "p_class_code": None,
        "p_actor_email": FACULTY_EMAIL,
        "p_request_key": f"portal-contract-check-{int(datetime.now(timezone.utc).timestamp())}",
    })
    check("H6 the browser booking contract works", status == 200 and isinstance(created, dict) and created.get("success") is True,
          created if not isinstance(created, dict) else created.get("error"))

    status, feed = call("/rest/v1/rpc/rpc_list_complaints", token=token, payload={
        "p_zone": "ALL", "p_status": "ACTIVE", "p_category": None, "p_my_department": False, "p_limit": 10})
    officers = [row.get("officer") or {} for row in feed] if isinstance(feed, list) else []
    check("H7 the feed shows the three curated tickets", isinstance(feed, list) and len(feed) == 3, len(feed) if isinstance(feed, list) else feed)
    check("H8 every live ticket names its area officer",
          all(officer.get("full_name") and officer.get("area") for officer in officers),
          [(officer.get("full_name"), officer.get("area")) for officer in officers])

    if isinstance(created, dict) and created.get("booking_id"):
        status, cancelled = call("/rest/v1/rpc/rpc_cancel_booking", token=token,
                                 payload={"p_booking_id": created["booking_id"], "p_actor_email": FACULTY_EMAIL})
        check("H9 the owner can release the room again",
              status == 200 and isinstance(cancelled, dict) and cancelled.get("status") == "CANCELLED",
              cancelled)

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
