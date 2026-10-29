"""Read-only diagnostics for the Supabase project."""

from __future__ import annotations

import sys

from sqlalchemy import text

sys.path.insert(0, ".")

from app.database import engine  # noqa: E402


def main() -> None:
    with engine.connect() as conn:
        print("version:", conn.execute(text("show server_version")).scalar_one())
        print("\nextensions:")
        for row in conn.execute(text("select extname, extnamespace::regnamespace::text from pg_extension order by 1")):
            print(" ", row[0], "->", row[1])

        print("\naudit hash mismatches:")
        mismatch = conn.execute(
            text(
                """
                select count(*) from audit_logs
                where row_hash <> encode(digest(
                  prev_hash || '|' ||
                  to_char(timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') || '|' ||
                  actor_email || '|' || actor_role || '|' || action || '|' ||
                  resource_type || '|' || resource_id || '|' || outcome || '|' ||
                  rule_fired || '|' || reason
                , 'sha256'), 'hex')
                """
            )
        ).scalar_one()
        zero_micro = conn.execute(
            text("select count(*) from audit_logs where extract(microseconds from timestamp)::int % 1000000 = 0")
        ).scalar_one()
        print("  mismatches:", mismatch, "zero-microsecond rows:", zero_micro)

        print("\nasset types:")
        for row in conn.execute(text("select asset_type, count(*) from assets group by 1 order by 1")):
            print(" ", row[0], row[1])

        print("\nroom aliases (block C floor 1):")
        for row in conn.execute(text("select code, zero_index_alias from rooms where code like 'C1-%' order by code")):
            print(" ", row[0], row[1])

        print("\nadmin accounts:")
        for row in conn.execute(
            text("select id, email, role from users where role in ('INCIDENT_MANAGER','FACILITIES_ADMIN','PROCUREMENT_APPROVER','SYSTEM_ADMIN') order by id")
        ):
            print(" ", row[0], row[1], row[2])

        print("\npublic tables:", conn.execute(text("select count(*) from information_schema.tables where table_schema='public'")).scalar_one())


if __name__ == "__main__":
    main()
