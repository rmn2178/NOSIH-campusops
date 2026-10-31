"""List every demo login and whether each has an auth account linked.

The seeded accounts all share the demo password, which the login screen
prints: Nosih@2026. This script lists the account inventory - role, email,
name and whether an auth seat exists - so a demo can be handed the right
credentials. It never reads a password or a token.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402

ROLE_ORDER = (
    "SYSTEM_ADMIN", "INCIDENT_MANAGER", "FACILITIES_ADMIN", "PROCUREMENT_APPROVER",
    "DEPARTMENT_MANAGER", "FACULTY", "LAB_STAFF", "MAINTENANCE", "STUDENT",
)


def main() -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select role, email, full_name, department_code, year_number,
                       auth_user_id is not null as linked
                  from public.users
                 where is_active
                 order by role, email
                """
            )
            rows = cur.fetchall()

    by_role: dict[str, list[tuple]] = {}
    for row in rows:
        by_role.setdefault(row[0], []).append(row)

    for role in ROLE_ORDER:
        accounts = by_role.get(role, [])
        if not accounts:
            continue
        linked = sum(1 for row in accounts if row[5])
        print(f"\n{role}  ({linked}/{len(accounts)} with an auth seat)")
        for _, email, name, department, year, has_seat in accounts:
            if not has_seat:
                continue
            detail = department or ""
            if year:
                detail = f"{detail} · year {year}"
            print(f"  {email:<34} {name:<28} {detail}")

    total = len(rows)
    linked_total = sum(1 for row in rows if row[5])
    print(f"\n{total} active profiles, {linked_total} with an auth seat")
    print("demo password: Nosih@2026")


if __name__ == "__main__":
    main()
