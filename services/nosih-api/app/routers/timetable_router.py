"""Read-only timetable inspection and constraint validation endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.engines.timetable_cpsat import DAYS, validate_timetable
from app.models import Room, StudentClass, TimetableSlot

router = APIRouter(prefix="/api/timetable", tags=["timetable"])


def _slot_dict(slot: TimetableSlot) -> dict[str, object]:
    return {
        "id": slot.id,
        "day_of_week": slot.day_of_week,
        "period_number": slot.period_number,
        "class_code": slot.class_code,
        "session_type": slot.session_type,
        "subject_code": slot.subject_code,
        "subject_title": slot.subject_title,
        "scheduled_space_code": slot.scheduled_space_code,
        "effective_space_code": slot.effective_space_code,
        "is_relocated": slot.is_relocated,
        "relocated_from_code": slot.relocated_from_code,
        "relocation_reason": slot.relocation_reason,
        "faculty_staff_code": slot.faculty_staff_code,
        "assisting_lab_staff_code": slot.assisting_lab_staff_code,
    }


def _ordered_slots(slots: list[TimetableSlot]) -> list[dict[str, object]]:
    day_order = {day: index for index, day in enumerate(DAYS)}
    slots.sort(
        key=lambda slot: (
            day_order.get(slot.day_of_week, 99),
            slot.period_number,
            slot.class_code,
        )
    )
    return [_slot_dict(slot) for slot in slots]


@router.get("/validate")
def validate(db: Session = Depends(get_db)) -> dict[str, object]:
    return validate_timetable(db)


@router.get("/class/{class_code}")
def timetable_for_class(
    class_code: str,
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    normalized_code = class_code.strip().upper()
    if db.query(StudentClass).filter(StudentClass.class_code == normalized_code).first() is None:
        raise HTTPException(status_code=404, detail=f"Unknown class: {class_code}")
    slots = db.query(TimetableSlot).filter(TimetableSlot.class_code == normalized_code).all()
    return _ordered_slots(slots)


@router.get("/space/{space_code}")
def timetable_for_space(
    space_code: str,
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    normalized_code = space_code.strip().upper()
    room = (
        db.query(Room)
        .filter(
            or_(
                Room.code == normalized_code,
                Room.zero_index_alias == normalized_code,
            )
        )
        .first()
    )
    canonical_code = room.code if room is not None else normalized_code
    slots = (
        db.query(TimetableSlot)
        .filter(
            or_(
                TimetableSlot.effective_space_code == canonical_code,
                TimetableSlot.scheduled_space_code == canonical_code,
            )
        )
        .all()
    )
    return _ordered_slots(slots)
