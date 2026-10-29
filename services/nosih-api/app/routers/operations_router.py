from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.engines.audit_chain import authorize
from app.engines.inventory_reservation import reserve_parts
from app.engines.room_conflict import evaluate_room_conflicts, relocate_room
from app.engines.sla_escalator import tick_sla_clocks
from app.engines.staff_assignment import assign_staff_to_work_order, rank_staff_for_work_order, rebalance_on_constraint_change
from app.models import User

router = APIRouter(tags=["phase-4-operations"])


class RelocateRoomRequest(BaseModel):
    faulted_space_code: str
    target_alternate_code: str
    day_of_week: str = Field(pattern="^(MON|TUE|WED|THU|FRI|SAT|SUN)$")
    from_period: int = Field(ge=1)
    reason: str = ""
    lock_id: str | int | None = None


class AssignStaffRequest(BaseModel):
    staff_code: str | None = None
    lock_id: str | int | None = None


class PartQuantityRequest(BaseModel):
    sku_code: str
    qty: int = Field(gt=0)


class ReservePartsRequest(BaseModel):
    parts: list[PartQuantityRequest] = Field(min_length=1)
    lock_id: str | int | None = None


class RebalanceRequest(BaseModel):
    staff_code: str
    trigger_reason: Literal["SHIFT_ENDED", "MARKED_LEAVE", "PREEMPTED_BY_CRITICAL"]


def _finish(db: Session, callback):
    try:
        result = callback()
        db.commit()
        return result
    except HTTPException:
        # Rejection audit rows must survive the HTTP error response.
        db.commit()
        raise
    except Exception:
        db.rollback()
        raise


def _authorize(db: Session, user: User, action: str, resource_type: str, resource_id: str | int) -> None:
    if not authorize(db, user, action, resource_type, resource_id):
        raise HTTPException(status_code=403, detail=f"Role {user.role} cannot perform {action}")


@router.get("/api/operations/rooms/conflicts/{space_code}")
def room_conflicts(
    space_code: str,
    day_of_week: str = Query(pattern="^(MON|TUE|WED|THU|FRI|SAT|SUN)$"),
    from_period: int = Query(ge=1),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return evaluate_room_conflicts(db, space_code, day_of_week, from_period, current_user=current_user)


@router.post("/api/operations/rooms/relocate")
def relocate(
    payload: RelocateRoomRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "ROOM_RELOCATE", "ROOM", payload.target_alternate_code)
        return relocate_room(db, current_user, **payload.model_dump())

    return _finish(db, execute)


@router.get("/api/work-orders/{wo_id}/staff-ranking")
def staff_ranking(
    wo_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return rank_staff_for_work_order(db, wo_id, current_user=current_user)


@router.post("/api/work-orders/{wo_id}/assign-staff")
def assign_staff(
    wo_id: int,
    payload: AssignStaffRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "ASSIGN_STAFF", "WORK_ORDER", wo_id)
        return assign_staff_to_work_order(db, wo_id, current_user, payload.staff_code, lock_id=payload.lock_id)

    return _finish(db, execute)


@router.post("/api/work-orders/{wo_id}/reserve-parts")
def reserve_work_order_parts(
    wo_id: int,
    payload: ReservePartsRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "RESERVE_PARTS", "WORK_ORDER", wo_id)
        return reserve_parts(db, wo_id, payload.parts, user=current_user, lock_id=payload.lock_id)

    return _finish(db, execute)


@router.post("/api/operations/staff/rebalance")
def rebalance_staff(
    payload: RebalanceRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "ASSIGN_STAFF", "STAFF", payload.staff_code)
        return rebalance_on_constraint_change(db, payload.staff_code, payload.trigger_reason)

    return _finish(db, execute)


@router.post("/api/operations/sla/tick")
def tick_clocks(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "UPDATE_CLOCK", "SLA", "ALL")
        return tick_sla_clocks(db)

    return _finish(db, execute)
