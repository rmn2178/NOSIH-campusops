"""List command-portal logins and whether each has an auth account linked."""
from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

ROLES = (
    "SYSTEM_ADMIN", "INCIDENT_MANAGER", "FACILITIES_ADMIN",
    "PROCUREMENT_APPROVER", "DEPARTMENT_MANAGER", "MAINTENANCE",
)


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select role, email, full_name, auth_user_id is not null as linked
                  from public.users
                 where role = any(%s)
                 order by role, email
                """,
                (list(ROLES),),
            )
            rows = cur.fetchall()
    for role, email, name, linked in rows:
        print(f"{role:<22} {email:<32} {'linked' if linked else 'NO AUTH':<8} {name}")
    print(f"\n{len(rows)} staff profiles")


if __name__ == "__main__":
    main()
