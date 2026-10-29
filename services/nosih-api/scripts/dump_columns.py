"""Dump column definitions for the tables touched by the Supabase migration."""

from __future__ import annotations

import sys

from sqlalchemy import text

sys.path.insert(0, ".")

from app.database import engine  # noqa: E402

TABLES = (
    "users", "complaints", "complaint_comments", "complaint_votes",
    "identity_vault", "resource_locks", "audit_logs", "rooms", "labs",
    "work_orders", "staff_profiles", "purchase_requests", "sla_clocks",
    "inventory_items", "part_reservations", "incidents", "notification_logs",
    "timetable_slots",
)


def main() -> None:
    with engine.connect() as conn:
        for table in TABLES:
            rows = conn.execute(
                text(
                    "select column_name, data_type, udt_name, is_nullable, column_default "
                    "from information_schema.columns where table_schema='public' and table_name=:t "
                    "order by ordinal_position"
                ),
                {"t": table},
            ).fetchall()
            print(f"\n== {table}")
            for name, dtype, udt, nullable, default in rows:
                print(f"  {name}: {dtype}/{udt} null={nullable} default={default}")


if __name__ == "__main__":
    main()
