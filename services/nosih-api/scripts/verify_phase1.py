import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
TEMP = tempfile.TemporaryDirectory()
os.environ["DATABASE_URL"] = f"sqlite:///{Path(TEMP.name) / 'verify.db'}"

from sqlalchemy import func, select

from app.database import Base, SessionLocal, engine
from app.engines.audit_chain import verify_audit_chain
from app.models import Asset, AuditLog, Complaint, InventoryItem, Lab, MaintenanceHistory, PurchaseRequest, Room, StaffProfile, StudentClass, TimetableSlot, User, WorkOrder
from app.seed.seed_campus import seed_campus

EXPECTED_TABLES = {
    "assets", "audit_logs", "bill_bots", "buildings", "canteens", "complaint_comments",
    "complaint_votes", "complaints", "departments", "distribution_boards", "floors",
    "identity_vault", "incidents", "inventory_items", "labs", "maintenance_history",
    "notification_logs", "part_reservations", "purchase_requests", "resource_locks",
    "rooms", "sla_clocks", "staff_profiles", "student_classes", "timetable_slots",
    "users", "work_orders",
}


def count(db, model) -> int:
    return db.scalar(select(func.count(model.id))) or 0


def main() -> None:
    Base.metadata.create_all(engine)
    assert set(Base.metadata.tables) == EXPECTED_TABLES, "The 27 explicitly specified model tables differ"
    with SessionLocal() as db:
        summary = seed_campus(db)
        assert count(db, Room) == 90
        assert count(db, Lab) == 20
        assert count(db, StudentClass) == 90
        assert count(db, TimetableSlot) == 2700
        assert count(db, Complaint) == 80
        assert count(db, WorkOrder) == 60
        assert count(db, PurchaseRequest) == 25
        assert count(db, MaintenanceHistory) == 50
        assert count(db, AuditLog) == 150
        assert count(db, InventoryItem) == 30
        assert count(db, Asset) == 2748
        assert len(db.scalars(select(Room).where(Room.code.like("A%"))).all()) == 18
        assert len(db.scalars(select(Room).where(Room.code.like("B%"))).all()) == 30
        assert len(db.scalars(select(Room).where(Room.code.like("C%"))).all()) == 42
        assert db.scalar(select(Room).where(Room.zero_index_alias == "C0-03")).code == "C1-03"
        assert count(db, User) == summary["students"] + 90 + 40 + 12 + 4
        assert db.scalar(select(func.sum(StudentClass.student_strength))) == summary["students"]
        assert len(db.scalars(select(StaffProfile).where(StaffProfile.staff_category == "LAB_STAFF")).all()) == 40
        assert len(db.scalars(select(StaffProfile).where(StaffProfile.staff_category == "MAINTENANCE_TECH")).all()) == 30
        zero_stock = {item.sku_code for item in db.scalars(select(InventoryItem).where(InventoryItem.on_hand_qty == 0)).all()}
        assert zero_stock == {"SKU-FAN-CAP", "SKU-SB-PSU", "SKU-MCB-63A", "SKU-BOT-HEAD"}
        for room in db.scalars(select(Room).order_by(Room.id).limit(2)).all():
            assert len(db.scalars(select(MaintenanceHistory).where(MaintenanceHistory.space_code == room.code)).all()) >= 2
        assert verify_audit_chain(db)["verified"]
        total_records = sum(db.scalar(select(func.count(table.c[0]))) or 0 for table in Base.metadata.sorted_tables)
        assert total_records > 7500
        print(f"Phase 1 verified: 27 models, {summary['students']} students, 2,700 timetable slots, {total_records:,} relational records, valid SHA-256 chain.")


if __name__ == "__main__":
    try:
        main()
    finally:
        engine.dispose()
        TEMP.cleanup()
