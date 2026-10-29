import json
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.engines.audit_chain import append_audit_log, authorize
from app.models import AuditLog, Complaint, InventoryItem, PurchaseRequest, Room, SlaClock, StaffProfile, User, WorkOrder
from app.serializers import purchase_request_dict

router = APIRouter(tags=["command-portal-contracts"])
ADMIN_ROLES = {"MAINTENANCE", "INCIDENT_MANAGER", "FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "SYSTEM_ADMIN"}
SKU_FOR_ASSET = {"SMART_BOARD": "SKU-SB-PSU", "CEILING_FAN": "SKU-FAN-CAP", "LED_LIGHT": "SKU-LED-DRIVER", "BILL_BOT_MECHANISM": "SKU-BOT-HEAD", "LAB_WORKSTATION": "SKU-LAB-SENSOR", "CANTEEN_APPLIANCE": "SKU-APPLIANCE-THERMOSTAT"}


def require_admin(user: User) -> None:
    if user.role not in ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Administrator role required")


class CompleteWorkOrderRequest(BaseModel):
    resolution_notes: str = ""


@router.get("/api/admin/purchase-requests")
def purchase_requests(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    require_admin(user)
    return [purchase_request_dict(row) for row in db.scalars(select(PurchaseRequest).order_by(PurchaseRequest.created_at.desc())).all()]


@router.get("/api/work-orders/{wo_id}/parts-preflight")
def parts_preflight(wo_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    require_admin(user)
    work_order = db.get(WorkOrder, wo_id)
    if not work_order:
        raise HTTPException(status_code=404, detail="Work order not found")
    codes = json.loads(work_order.target_asset_codes_json or "[]")
    skus = sorted({SKU_FOR_ASSET[code.split("-")[0] if code.split("-")[0] in SKU_FOR_ASSET else "SMART_BOARD"] for code in codes if code.split("-")[0] in SKU_FOR_ASSET}) if codes else []
    if not skus:
        skus = ["SKU-FAN-CAP"]
    requested = [{"sku_code": sku, "quantity": 1} for sku in skus]
    available, unavailable = [], []
    for request in requested:
        item = db.scalar(select(InventoryItem).where(InventoryItem.sku_code == request["sku_code"]))
        if item and item.on_hand_qty - item.reserved_qty >= request["quantity"]:
            available.append({"id": item.id, "sku_code": item.sku_code, "name": item.part_name, "part_name": item.part_name, "category": item.category, "unit": "units", "on_hand_qty": item.on_hand_qty, "reserved_qty": item.reserved_qty, "available_qty": item.on_hand_qty - item.reserved_qty, "reorder_level": item.reorder_threshold, "unit_cost_inr": item.unit_cost_inr})
        else:
            unavailable.append({"code": request["sku_code"], "name": item.part_name if item else "Unknown part", "reason": f"ZERO_FREE_STOCK (available {max(0, item.on_hand_qty - item.reserved_qty) if item else 0})"})
    checks = [
        {"rule": "STOCK_AVAILABILITY", "label": "All requested parts available", "passed": not unavailable, "detail": f"{len(available)} available, {len(unavailable)} short"},
        {"rule": "NO_PARTIAL_RESERVATION", "label": "Atomic all-or-nothing reservation", "passed": True, "detail": "A shortage blocks the entire reservation"},
        {"rule": "WORK_ORDER_STATE", "label": "Work order is open", "passed": work_order.status in {"PENDING_ASSIGNMENT", "ASSIGNED", "IN_PROGRESS", "BLOCKED_PARTS"}, "detail": work_order.status},
    ]
    return {"work_order_id": work_order.id, "requested_parts": requested, "available_parts": available, "unavailable_parts": unavailable, "preflight_checks": checks}


@router.post("/api/work-orders/{wo_id}/complete")
def complete_work_order(wo_id: int, payload: CompleteWorkOrderRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    require_admin(user)
    work_order = db.get(WorkOrder, wo_id)
    if not work_order:
        raise HTTPException(status_code=404, detail="Work order not found")
    if work_order.status in {"RESOLVED", "CLOSED", "COMPLETED"}:
        raise HTTPException(status_code=409, detail="Work order is already complete")
    work_order.status = "RESOLVED"
    work_order.completed_at = datetime.now(timezone.utc)
    if work_order.complaint:
        work_order.complaint.status = "RESOLVED"
    room = db.scalar(select(Room).where(Room.code == work_order.space_code))
    open_work = db.scalar(
        select(WorkOrder).where(
            WorkOrder.space_code == work_order.space_code,
            WorkOrder.status.notin_({"RESOLVED", "CLOSED", "COMPLETED"}),
            WorkOrder.id != work_order.id,
        )
    )
    active_complaint = db.scalar(
        select(Complaint).where(
            Complaint.space_code == work_order.space_code,
            Complaint.moderation_status == "APPROVED",
            Complaint.status.notin_({"RESOLVED", "CLOSED", "REJECTED", "CANCELLED"}),
        )
    )
    if room:
        room.visual_state = "HEALTHY" if not open_work and not active_complaint else "DEGRADED"
    if work_order.assigned_staff_code:
        profile = db.scalar(select(StaffProfile).where(StaffProfile.staff_code == work_order.assigned_staff_code))
        if profile:
            profile.current_active_jobs = max(0, profile.current_active_jobs - 1)
    clock = db.scalar(select(SlaClock).where(SlaClock.target_type == "WORK_ORDER", SlaClock.target_id == work_order.id))
    if clock:
        clock.is_paused = True
        clock.pause_reason = "WORK_ORDER_COMPLETED"
    append_audit_log(db, actor=user, action="COMPLETE_WORK_ORDER", resource_type="WORK_ORDER", resource_id=work_order.wo_number, outcome="ALLOWED", rule_fired="REPAIR_VERIFIED_COMPLETE", reason=payload.resolution_notes or "Repair completed")
    db.commit()
    from app.serializers import work_order_dict
    return work_order_dict(work_order)


@router.get("/api/audit")
def list_audit(q: str = "", limit: int = 500, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict[str, Any]]:
    require_admin(user)
    query = select(AuditLog).order_by(AuditLog.id.desc()).limit(min(limit, 1000))
    if q:
        query = query.where(or_(AuditLog.action.ilike(f"%{q}%"), AuditLog.actor_email.ilike(f"%{q}%"), AuditLog.resource_id.ilike(f"%{q}%"), AuditLog.rule_fired.ilike(f"%{q}%")))
    rows = db.scalars(query).all()
    return [{"id": row.id, "sequence_number": row.id, "timestamp": row.timestamp, "actor_email": row.actor_email, "actor_role": row.actor_role, "action": row.action, "resource_type": row.resource_type, "resource_id": row.resource_id, "outcome": row.outcome, "rule_fired": row.rule_fired, "reason": row.reason, "prev_hash": row.prev_hash, "row_hash": row.row_hash} for row in rows]


@router.post("/api/staff/{staff_code}/constraint-change")
def staff_constraint_change(staff_code: str, payload: dict[str, str], db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict[str, Any]:
    if not authorize(db, user, "ASSIGN_STAFF", "STAFF", staff_code):
        db.commit()
        raise HTTPException(status_code=403, detail="Role cannot rebalance staff")
    from app.engines.staff_assignment import rebalance_on_constraint_change
    result = rebalance_on_constraint_change(db, staff_code, payload.get("trigger_reason", "SHIFT_ENDED"))
    db.commit()
    return result
