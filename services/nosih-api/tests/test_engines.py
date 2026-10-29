from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.engines.audit_chain import verify_audit_chain
from app.engines.inventory_reservation import receive_stock, reserve_parts
from app.engines.procurement_approval import approve_purchase_request
from app.engines.resource_lock import claim_resource_lock
from app.engines.room_conflict import evaluate_room_conflicts, relocate_room
from app.engines.sla_escalator import tick_sla_clock
from app.engines.staff_assignment import rank_staff_for_work_order, rebalance_on_constraint_change
from app.models import (
    Asset,
    AuditLog,
    Building,
    Department,
    DistributionBoard,
    Floor,
    InventoryItem,
    NotificationLog,
    PartReservation,
    PurchaseRequest,
    Room,
    SlaClock,
    StaffProfile,
    StudentClass,
    TimetableSlot,
    User,
    WorkOrder,
)


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        yield session
    engine.dispose()


def user(db: Session, email: str, role: str, name: str | None = None) -> User:
    record = User(email=email, full_name=name or email.split("@")[0].title(), role=role, is_active=True)
    db.add(record)
    db.flush()
    return record


def room(db: Session, code: str, floor: Floor, board: DistributionBoard, capacity: int = 60) -> Room:
    record = Room(
        code=code,
        zero_index_alias=f"Z-{code}",
        building_id=floor.building_id,
        floor_id=floor.id,
        room_number_on_floor=int(code.rsplit("-", 1)[1]),
        capacity=capacity,
        distribution_board_id=board.id,
        visual_state="HEALTHY",
    )
    db.add(record)
    db.flush()
    db.add(
        Asset(
            asset_code=f"SB-{code}-01",
            name="Smart Board",
            asset_type="SMART_BOARD",
            parent_space_type="ROOM",
            parent_space_code=code,
            slot_index=1,
            status="OK",
        )
    )
    return record


def campus(db: Session) -> tuple[Floor, DistributionBoard]:
    building = Building(code="C", name="Block C", total_floors=1)
    db.add(building)
    db.flush()
    floor = Floor(building_id=building.id, floor_number=1, code="C1", elevation_y=0)
    board = DistributionBoard(code="DB-C1", building_id=building.id, floor_number=1, wing="EAST")
    db.add_all([floor, board])
    db.flush()
    return floor, board


def test_room_relocation_uses_vacant_home_room_and_notifies(db: Session):
    floor, board = campus(db)
    faulted = room(db, "C1-01", floor, board)
    alternate = room(db, "C1-02", floor, board)
    faulted.visual_state = "FAULTY"
    admin = user(db, "admin@nosih.edu.in", "FACILITIES_ADMIN", "Admin")
    advisor = user(db, "advisor@nosih.edu.in", "FACULTY", "Advisor")
    student = user(db, "student@nosih.edu.in", "STUDENT", "Student")
    student.class_code = "CSE-Y3-A"
    department = Department(code="CSE", full_name="Computer Science")
    db.add(department)
    db.flush()
    affected_class = StudentClass(
        class_code="CSE-Y3-A", department_id=department.id, year_number=3, section_letter="A",
        student_strength=57, home_room_code=faulted.code, advisor_faculty_id=advisor.id, required_lab_pool="COMPUTING",
    )
    home_class = StudentClass(
        class_code="CYBER-Y3-B", department_id=department.id, year_number=3, section_letter="B",
        student_strength=55, home_room_code=alternate.code, advisor_faculty_id=advisor.id, required_lab_pool="COMPUTING",
    )
    db.add_all([affected_class, home_class])
    db.flush()
    alternate.home_class_id = home_class.id
    db.add_all([
        TimetableSlot(
            day_of_week="MON", period_number=3, class_code=affected_class.class_code, session_type="THEORY",
            subject_code="CS301", subject_title="Databases", scheduled_space_code=faulted.code,
            effective_space_code=faulted.code, faculty_staff_code="FAC-001",
        ),
        TimetableSlot(
            day_of_week="MON", period_number=3, class_code=home_class.class_code, session_type="LAB",
            subject_code="CS302", subject_title="DBMS Lab", scheduled_space_code="LAB-DBMS-01",
            effective_space_code="LAB-DBMS-01", faculty_staff_code="FAC-002",
        ),
    ])
    db.commit()

    evaluation = evaluate_room_conflicts(db, faulted.code, "MON", 3, current_user=admin)
    assert evaluation["available_alternates"][0]["space_code"] == alternate.code
    assert "home class CYBER-Y3-B is in LAB-DBMS-01" in evaluation["available_alternates"][0]["explanation"]

    claim_resource_lock(db, admin, "ROOM", alternate.code)
    result = relocate_room(
        db, admin, faulted_space_code=faulted.code, target_alternate_code=alternate.code,
        day_of_week="MON", from_period=3, reason="Smart board fault",
    )
    db.commit()
    relocated = db.scalars(select(TimetableSlot).where(TimetableSlot.class_code == affected_class.class_code)).one()
    assert result["relocated_slots"] == 1
    assert relocated.effective_space_code == alternate.code
    assert relocated.is_relocated is True
    assert relocated.relocated_from_code == faulted.code
    assert db.query(NotificationLog).count() == 2


def test_lock_contention_returns_409_and_rejected_audit(db: Session):
    first = user(db, "first@nosih.edu.in", "FACILITIES_ADMIN", "Vikram")
    second = user(db, "second@nosih.edu.in", "INCIDENT_MANAGER", "Asha")
    claim_resource_lock(db, first, "ROOM", "C4-05")

    with pytest.raises(HTTPException) as caught:
        claim_resource_lock(db, second, "ROOM", "C4-05")
    assert caught.value.status_code == 409
    assert caught.value.detail["locked_by_name"] == "Vikram"
    assert caught.value.detail["expires_in_seconds"] <= 300
    rejected = db.scalars(select(AuditLog).where(AuditLog.outcome == "REJECTED")).one()
    assert rejected.rule_fired == "RESOURCE_LOCK_HELD_BY_ANOTHER_USER"
    assert verify_audit_chain(db)["verified"] is True


def test_stock_out_auto_pr_then_receiving_unblocks_and_resumes_sla(db: Session):
    floor, board = campus(db)
    space = room(db, "C1-01", floor, board)
    requester = user(db, "maint@nosih.edu.in", "MAINTENANCE")
    approver = user(db, "procurement@nosih.edu.in", "PROCUREMENT_APPROVER")
    db.add(Department(code="CSE", full_name="Computer Science", monthly_maintenance_budget_inr=100000))
    requester.department_code = "CSE"
    item = InventoryItem(
        sku_code="SKU-SB-PSU", part_name="Power Supply", category="IT_SMARTBOARD",
        on_hand_qty=0, reserved_qty=0, reorder_threshold=5, unit_cost_inr=2400,
    )
    work_order = WorkOrder(
        wo_number="WO-2026-0001", space_code=space.code, required_skill="IT_AV", priority_score=90,
        status="ASSIGNED",
    )
    db.add_all([item, work_order])
    db.flush()
    clock = SlaClock(
        target_type="WORK_ORDER", target_id=work_order.id, space_code=space.code, urgency="HIGH",
        response_target_mins=30, resolution_target_mins=120, last_tick_at=datetime.now(timezone.utc),
    )
    db.add(clock)
    db.commit()

    result = reserve_parts(db, work_order.id, [{"sku_code": item.sku_code, "qty": 1}])
    db.commit()
    assert result["stock_out"] is True
    assert result["reservations"] == []
    assert work_order.status == "BLOCKED_PARTS"
    assert space.visual_state == "BLOCKED_PARTS"
    assert clock.is_paused is True
    assert clock.pause_reason == "Awaiting stock for SKU-SB-PSU"
    pr = db.scalars(select(PurchaseRequest)).one()
    assert pr.quantity_requested == 6
    assert db.query(PartReservation).count() == 0

    approve_purchase_request(db, approver, pr.id)
    received = receive_stock(db, pr.id, user=approver)
    db.commit()
    assert received["unblocked_work_orders"][0]["work_order_id"] == work_order.id
    assert work_order.status == "IN_PROGRESS"
    assert space.visual_state == "HEALTHY"
    assert clock.is_paused is False
    assert clock.pause_reason is None
    assert item.reserved_qty == 1


def test_self_approval_rejected_then_second_role_approval(db: Session):
    requester = user(db, "requester@nosih.edu.in", "MAINTENANCE")
    approver = user(db, "approver@nosih.edu.in", "PROCUREMENT_APPROVER")
    db.add(Department(code="CSE", full_name="Computer Science", monthly_maintenance_budget_inr=50000))
    db.add(InventoryItem(
        sku_code="SKU-SB-PSU", part_name="Power Supply", category="IT_SMARTBOARD", unit_cost_inr=2400,
    ))
    db.flush()
    pr = PurchaseRequest(
        pr_number="PR-2026-0001", department_code="CSE", sku_code="SKU-SB-PSU", quantity_requested=1,
        unit_cost_inr=2400, total_cost_inr=2400, requested_by_user_id=requester.id,
    )
    db.add(pr)
    db.commit()

    with pytest.raises(HTTPException) as caught:
        approve_purchase_request(db, requester, pr.id)
    assert caught.value.status_code == 403
    assert caught.value.detail["rule_fired"] in {"RBAC_ROLE_NOT_PERMITTED", "SEPARATION_OF_DUTIES_SELF_APPROVAL"}
    assert db.scalars(select(AuditLog).where(AuditLog.outcome == "REJECTED")).one()

    approved = approve_purchase_request(db, approver, pr.id)
    assert approved["approved"] is True
    assert pr.status == "APPROVED"
    assert verify_audit_chain(db)["verified"] is True


def test_sla_thresholds_and_paused_time(db: Session):
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    clock = SlaClock(
        target_type="WORK_ORDER", target_id=1, space_code="C1-01", urgency="HIGH",
        response_target_mins=30, resolution_target_mins=100, elapsed_active_mins=74,
        last_tick_at=start,
    )
    db.add(clock)
    db.flush()
    warning = tick_sla_clock(db, clock, start + timedelta(minutes=1))
    assert warning["breach_state"] == "WARNING_75"
    assert warning["notifications_sent"] == 2

    clock.is_paused = True
    paused = tick_sla_clock(db, clock, start + timedelta(minutes=51))
    assert paused["elapsed_active_mins"] == 75
    clock.is_paused = False
    breached = tick_sla_clock(db, clock, start + timedelta(minutes=76))
    assert breached["breach_state"] == "BREACHED_100"
    assert breached["current_escalation_tier"] == 2
    assert breached["notifications_sent"] == 2


def test_staff_math_breakdown_and_automatic_rebalance(db: Session):
    old_user = user(db, "old-tech@nosih.edu.in", "MAINTENANCE", "Old Technician")
    new_user = user(db, "new-tech@nosih.edu.in", "MAINTENANCE", "New Technician")
    old = StaffProfile(
        user_id=old_user.id, staff_code="MAINT-01", staff_category="MAINTENANCE_TECH",
        primary_skill="ELECTRICAL", skill_proficiency=3, risk_clearance="HIGH_VOLTAGE",
        hourly_cost_inr=400, current_block_location="C", current_active_jobs=1,
    )
    new = StaffProfile(
        user_id=new_user.id, staff_code="MAINT-02", staff_category="MAINTENANCE_TECH",
        primary_skill="ELECTRICAL", skill_proficiency=5, risk_clearance="HIGH_VOLTAGE",
        hourly_cost_inr=400, current_block_location="C", current_active_jobs=0,
    )
    work_order = WorkOrder(
        wo_number="WO-2026-0002", space_code="C1-01", required_skill="ELECTRICAL",
        required_risk_clearance="HIGH_VOLTAGE", priority_score=90, assigned_staff_code=old.staff_code,
        status="IN_PROGRESS",
    )
    db.add_all([old, new, work_order])
    db.commit()

    ranking = rank_staff_for_work_order(db, work_order.id)
    assert [entry["staff_code"] for entry in ranking["available_ranked"]] == [new.staff_code, old.staff_code]
    assert len(ranking["available_ranked"][0]["math_breakdown"]["terms"]) == 6

    result = rebalance_on_constraint_change(db, old.staff_code, "PREEMPTED_BY_CRITICAL")
    assert result["reassigned_count"] == 1
    assert work_order.assigned_staff_code == new.staff_code
    assert work_order.reassignment_count == 1
    assert work_order.last_reassignment_reason == "PREEMPTED_BY_CRITICAL"
    assert old.current_active_jobs == 0
    assert new.current_active_jobs == 1
    assert db.scalars(select(AuditLog).where(AuditLog.action == "AUTO_REASSIGNED")).one()
