"""Create Supabase Auth accounts for the seeded command-portal roles.

Password is the seeded staff password (Nosih@2026). The auth trigger links each
new auth user to the existing public.users profile by email.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

from sqlalchemy import text

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402
from app.database import engine  # noqa: E402

STAFF_PASSWORD = "Nosih@2026"
ROLES = (
    "MAINTENANCE", "INCIDENT_MANAGER", "FACILITIES_ADMIN",
    "PROCUREMENT_APPROVER", "SYSTEM_ADMIN",
)


def admin_request(path: str, payload: dict | None = None) -> tuple[int, dict | list | None]:
    key = settings.supabase_admin_key
    if not settings.supabase_url or not key:
        raise SystemExit("SUPABASE_URL / secret key missing")
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{settings.supabase_url}{path}",
        data=data,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = body.decode("utf-8", "replace")
        return exc.code, parsed


def main() -> None:
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "select id, email, full_name, role, department_code, year_number "
                "from public.users where role = any(:roles) order by id"
            ),
            {"roles": list(ROLES)},
        ).fetchall()

    print(f"seeding {len(rows)} auth users")
    for user_id, email, full_name, role, department, year in rows:
        status, body = admin_request("/auth/v1/admin/users", {
            "email": email,
            "password": STAFF_PASSWORD,
            "email_confirm": True,
            "user_metadata": {
                "full_name": full_name,
                "role": role,
                "department_code": department,
                "year_number": year,
            },
        })
        if status in (200, 201):
            print(f"  created {email} ({role})")
        elif status == 422:
            print(f"  exists  {email} ({role})")
        else:
            print(f"  ERROR   {email}: {status} {body}")

    with engine.connect() as conn:
        linked = conn.execute(
            text("select count(*) from public.users where auth_user_id is not null")
        ).scalar_one()
    print(f"linked profiles: {linked}")


if __name__ == "__main__":
    main()
