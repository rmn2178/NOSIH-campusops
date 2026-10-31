"""Give every campus profile a portal seat, so signing in never needs mail.

The complaint portal used to open a missing account with the browser sign-up
call, which sends a confirmation email. That burned the project's mail quota
and left the portal unable to sign anybody in, because @nosih.edu.in mail does
not exist. This script opens the seats directly with the admin API and
``email_confirm``, so no mail is sent and every member of the campus register
can sign in with the demo password.

Usage:
    .venv/Scripts/python.exe scripts/seed_all_seats.py            # every seat
    .venv/Scripts/python.exe scripts/seed_all_seats.py --limit 40 # a sample
    .venv/Scripts/python.exe scripts/seed_all_seats.py --dry-run
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402
from app.config import settings  # noqa: E402

SEAT_PASSWORD = "Nosih@2026"
WORKERS = 8


def admin_create(email: str, full_name: str, role: str, department: str | None, year: int | None):
    """Create one confirmed auth user. Returns (status, message)."""
    key = settings.supabase_admin_key
    payload = json.dumps({
        "email": email,
        "password": SEAT_PASSWORD,
        "email_confirm": True,
        "user_metadata": {
            "full_name": full_name,
            "role": role,
            "department_code": department,
            "year_number": year,
        },
    }).encode()
    request = urllib.request.Request(
        f"{settings.supabase_url}/auth/v1/admin/users",
        data=payload,
        headers={
            "apikey": key or "",
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, ""
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:160]


def create_seat(row) -> str:
    email, full_name, role, department, year = row
    for attempt in range(4):
        status, message = admin_create(email, full_name, role, department, year)
        if status in (200, 201):
            return "created"
        if status == 422:
            return "exists"
        if status == 429:
            time.sleep(1.5 * (attempt + 1))
            continue
        return f"error {status} {message}"
    return "rate limited after 4 attempts"


def main() -> None:
    dry_run = "--dry-run" in sys.argv
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])

    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                select email, full_name, role, department_code, year_number
                  from public.users
                 where auth_user_id is null and is_active
                 order by role, email""")
            rows = cur.fetchall()
        conn.rollback()

    if limit is not None:
        rows = rows[:limit]

    print(f"{len(rows)} profiles without a seat")
    if dry_run:
        for row in rows[:10]:
            print("  ", row[0], row[2])
        return

    started = time.time()
    tally: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for outcome in pool.map(create_seat, rows):
            tally[outcome.split(" ")[0]] = tally.get(outcome.split(" ")[0], 0) + 1
    elapsed = time.time() - started

    # The auth trigger links a new seat to its profile by email; this closes any
    # gap for the seats that already existed.
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                update public.users u
                   set auth_user_id = a.id
                  from auth.users a
                 where u.auth_user_id is null
                   and lower(u.email) = lower(a.email)""")
            linked = cur.rowcount
        conn.rollback()

    print(f"done in {elapsed:.1f}s: " + ", ".join(f"{k} {v}" for k, v in sorted(tally.items())))
    print(f"profiles linked to an existing seat: {linked}")

    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                select role, count(*) filter (where auth_user_id is null) as missing, count(*) as total
                  from public.users where is_active group by role order by role""")
            for role, missing, total in cur.fetchall():
                print(f"  {role:22} missing {missing}/{total}")
        conn.rollback()


if __name__ == "__main__":
    main()
