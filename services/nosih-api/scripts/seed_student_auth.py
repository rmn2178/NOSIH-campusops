"""Create one Supabase Auth student account per class (roll 01)."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

from sqlalchemy import text

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402
from app.database import engine  # noqa: E402

PASSWORD = "Nosih@2026"


def create_user(email: str, full_name: str, department: str, year: int) -> tuple[int, str]:
    key = settings.supabase_admin_key
    payload = json.dumps({
        "email": email,
        "password": PASSWORD,
        "email_confirm": True,
        "user_metadata": {
            "full_name": full_name,
            "role": "STUDENT",
            "department_code": department,
            "year_number": year,
        },
    }).encode()
    request = urllib.request.Request(
        f"{settings.supabase_url}/auth/v1/admin/users",
        data=payload,
        headers={"apikey": key or "", "Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, ""
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:120]


def main() -> None:
    with engine.connect() as conn:
        rows = conn.execute(text(
            "select email, full_name, department_code, year_number from public.users "
            "where role = 'STUDENT' and email ~ '[a-z][0-9][a-z]01@nosih\\.edu\\.in' "
            "order by email"
        )).fetchall()

    print(f"seeding {len(rows)} student auth users")
    ok = 0
    for email, full_name, department, year in rows:
        status, message = create_user(email, full_name, department, year or 1)
        if status in (200, 201):
            ok += 1
        elif status == 422:
            ok += 1
        else:
            print(f"  ERROR {email}: {status} {message}")
    print(f"ready: {ok}/{len(rows)}")

    with engine.connect() as conn:
        linked = conn.execute(text(
            "select count(*) from public.users where auth_user_id is not null"
        )).scalar_one()
    print(f"linked profiles: {linked}")


if __name__ == "__main__":
    main()
