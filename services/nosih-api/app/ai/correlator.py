from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Asset, Complaint, Incident, MaintenanceHistory, Room, StudentClass


def _incident_number(db: Session) -> str:
    count = len(db.scalars(select(Incident.id)).all()) + 1
    return f"INC-2026-{count:04d}"


def correlate_complaint(db: Session, complaint: Complaint) -> Incident | None:
    if complaint.category not in {"ELECTRICAL", "FANS_HVAC", "IT_SMARTBOARD", "PLUMBING"}:
        return None
    room = db.scalar(select(Room).where(Room.code == complaint.space_code))
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=30)
    related: list[Complaint] = []
    root_key = ""
    correlation_type = ""
    if room and complaint.category != "PLUMBING":
        rooms = db.scalars(select(Room).where(Room.distribution_board_id == room.distribution_board_id)).all()
        codes = [item.code for item in rooms]
        related = list(db.scalars(select(Complaint).where(Complaint.space_code.in_(codes), Complaint.created_at >= cutoff, Complaint.moderation_status == "APPROVED", Complaint.category.in_(["ELECTRICAL", "FANS_HVAC", "IT_SMARTBOARD"]))).all())
        if len({item.space_code for item in related}) >= 2:
            root_key = room.distribution_board.code
            correlation_type = "DISTRIBUTION_BOARD"
    elif room and complaint.category == "PLUMBING":
        related = list(db.scalars(select(Complaint).where(Complaint.space_code.like(f"{room.code[0]}%-{room.code[-2:]}"), Complaint.created_at >= cutoff, Complaint.category == "PLUMBING", Complaint.moderation_status == "APPROVED")).all())
        if len({item.space_code for item in related}) >= 2:
            root_key = f"RISER-{room.code[0]}-{room.code[-2:]}"
            correlation_type = "FLOOR_CLUSTER"
    if not related or not root_key:
        return None
    incident = db.scalar(select(Incident).where(Incident.root_cause_key == root_key, Incident.status.in_(["ACTIVE", "MITIGATING", "BLOCKED_PARTS"])))
    room_codes = sorted({item.space_code for item in related})
    classes = db.scalars(select(StudentClass).where(StudentClass.home_room_code.in_(room_codes))).all()
    students = sum(item.student_strength for item in classes)
    if not incident:
        incident = Incident(
            incident_number=_incident_number(db),
            title=f"Correlated faults at {root_key}",
            correlation_type=correlation_type,
            root_cause_key=root_key,
            severity=complaint.urgency,
            ai_summary_text="",
        )
        db.add(incident)
        db.flush()
    incident.affected_rooms_csv = ",".join(room_codes)
    incident.affected_classes_csv = ",".join(item.class_code for item in classes)
    incident.total_students_impacted = students
    incident.ai_summary_text = f"{len(room_codes)} rooms ({', '.join(room_codes)}) affect {len(classes)} classes and exactly {students} students. Suspected root cause: {root_key}. Highest reported urgency: {complaint.urgency}."
    for item in related:
        item.linked_incident_id = incident.id
    return incident


def chronic_replacement_required(db: Session, space_code: str, asset_code: str) -> bool:
    asset = db.scalar(select(Asset).where(Asset.asset_code == asset_code))
    if not asset:
        return False
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    codes = db.scalars(select(Asset.asset_code).where(Asset.parent_space_code == space_code, Asset.asset_type == asset.asset_type)).all()
    count = len(db.scalars(select(MaintenanceHistory).where(MaintenanceHistory.space_code == space_code, MaintenanceHistory.asset_code.in_(codes), MaintenanceHistory.completed_at >= cutoff)).all())
    return count >= 2
