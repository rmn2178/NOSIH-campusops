"""Print row counts and connection facts for the configured database."""

from __future__ import annotations

import sys

from sqlalchemy import text

sys.path.insert(0, ".")

from app.database import engine  # noqa: E402

TABLES = (
    "buildings", "floors", "distribution_boards", "rooms", "labs", "canteens",
    "bill_bots", "assets", "departments", "student_classes", "users",
    "staff_profiles", "timetable_slots", "identity_vault", "complaints",
    "complaint_comments", "complaint_votes", "incidents", "work_orders",
    "inventory_items", "part_reservations", "purchase_requests", "sla_clocks",
    "resource_locks", "maintenance_history", "notification_logs", "audit_logs",
)


def main() -> None:
    with engine.connect() as conn:
        print("server:", conn.execute(text("select current_user, current_database(), inet_server_addr()::text")).fetchone())
        for table in TABLES:
            count = conn.execute(text(f'select count(*) from "{table}"')).scalar_one()
            print(f"{table}: {count}")


if __name__ == "__main__":
    main()
