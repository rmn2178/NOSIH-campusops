"""Create Supabase Auth accounts for seeded staff roles.

Default run provisions every department manager plus one faculty member per
department and one lab-staff account. Pass --all to create accounts for every
non-student profile that does not have one yet.

All seeded accounts use the staff password Nosih@2026. The auth trigger links
each new auth user to the existing public.users profile by email.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

STAFF_PASSWORD = "Nosih@2026"


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


def targets(seed_all: bool) -> list[tuple[str, str, str, str | None, int | None]]:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            if seed_all:
                cur.execute(
                    """
                    select email, full_name, role, department_code, year_number
                      from public.users
                     where role <> 'STUDENT' and auth_user_id is null and is_active
                     order by role, email
                    """
                )
            else:
                cur.execute(
                    """
                    with faculty as (
                      select distinct on (department_code)
                             email, full_name, role, department_code, year_number
                        from public.users
                       where role = 'FACULTY' and auth_user_id is null and is_active
                       order by department_code, email
                    ), lab as (
                      select email, full_name, role, department_code, year_number
                        from public.users
                       where role = 'LAB_STAFF' and auth_user_id is null and is_active
                       order by email
                       limit 1
                    )
                    select * from faculty
                    union all select * from lab
                    union all
                    select email, full_name, role, department_code, year_number
                      from public.users
                     where role = 'DEPARTMENT_MANAGER' and auth_user_id is null and is_active
                    order by role, email
                    """
                )
            return cur.fetchall()


def main() -> None:
    seed_all = "--all" in sys.argv
    rows = targets(seed_all)
    print(f"seeding {len(rows)} auth users ({'all staff' if seed_all else 'demo set'})")
    failures = 0
    for email, full_name, role, department, year in rows:
        status, body = admin_request(
            "/auth/v1/admin/users",
            {
                "email": email,
                "password": STAFF_PASSWORD,
                "email_confirm": True,
                "user_metadata": {
                    "full_name": full_name,
                    "role": role,
                    "department_code": department,
                    "year_number": year,
                },
            },
        )
        if status in (200, 201):
            print(f"  created {email} ({role})")
        elif status == 422:
            print(f"  exists  {email} ({role})")
        elif status == 429:
            failures += 1
            print(f"  RATE    {email}: retrying after 2s")
            time.sleep(2)
            retry_status, retry_body = admin_request(
                "/auth/v1/admin/users",
                {
                    "email": email,
                    "password": STAFF_PASSWORD,
                    "email_confirm": True,
                    "user_metadata": {"full_name": full_name, "role": role,
                                      "department_code": department, "year_number": year},
                },
            )
            print(f"  {'created' if retry_status in (200, 201) else 'ERROR  '} {email}: {retry_status}")
            failures += 0 if retry_status in (200, 201, 422) else 1
        else:
            failures += 1
            print(f"  ERROR   {email}: {status} {body}")

    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                update public.users u
                   set auth_user_id = a.id
                  from auth.users a
                 where u.auth_user_id is null
                   and lower(u.email) = lower(a.email)
                """
            )
            relinked = cur.rowcount
            cur.execute(
                "select role, count(*), count(auth_user_id) from public.users "
                "where role <> 'STUDENT' group by 1 order by 1"
            )
            summary = cur.fetchall()
        conn.commit()
    print(f"linked {relinked} existing auth rows")
    for role, total, linked in summary:
        print(f"  {role:<22} {linked}/{total} linked")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
