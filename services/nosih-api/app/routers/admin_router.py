import json
from datetime import datetime, timezone
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.pipeline import run_complaint_pipeline
from app.auth import get_current_user
from app.database import get_db
from app.engines.anonymity_vault import unseal_identity
from app.engines.audit_chain import append_audit_log, authorize
from app.models import Complaint, ComplaintComment, IdentityVault, Incident, InventoryItem, SlaClock, StaffProfile, User, WorkOrder
from app.schemas.complaints import VaultUnsealRequest
from app.serializers import comment_dict, complaint_dict, purchase_request_dict, work_order_dict
from app.ws_manager import ws_hub

router = APIRouter(prefix="/api/admin", tags=["administration"])
ADMIN_ROLES = {"MAINTENANCE", "INCIDENT_MANAGER", "FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "SYSTEM_ADMIN"}


def require_admin(user: User) -> None:
    if user.role not in ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="Administrator role required")


@router.get("/moderation")
def moderation_queue(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    require_admin(user)
    complaints = db.scalars(select(Complaint).where(Complaint.moderation_status.in_(["HELD_ABUSIVE", "HELD_HARMFUL", "NEEDS_REWRITE"])).order_by(Complaint.created_at.desc())).all()
    comments = db.scalars(select(ComplaintComment).where(ComplaintComment.moderation_status.in_(["HELD_ABUSIVE", "HELD_HARMFUL", "NEEDS_REWRITE"])).order_by(ComplaintComment.created_at.desc())).all()
    items: list[dict[str, Any]] = []
    for item in complaints:
        items.append({"id": item.id, "complaint_id": item.id, "submitted_text": f"{item.title}\n{item.description}", "moderation_status": item.moderation_status, "moderation_reason": item.moderation_reason or "", "public_reporter_label": item.public_reporter_label, "space_code": item.space_code, "vault_token": item.vault_token, "is_anonymous": item.is_anonymous, "created_at": item.created_at})
    for item in comments:
        complaint = db.get(Complaint, item.complaint_id)
        items.append({"id": f"comment-{item.id}", "complaint_id": item.complaint_id, "submitted_text": item.body, "moderation_status": item.moderation_status, "moderation_reason": "Comment held by Stage 1 moderation", "public_reporter_label": item.public_author_label, "space_code": complaint.space_code if complaint else None, "vault_token": item.vault_token, "is_anonymous": item.is_anonymous, "created_at": item.created_at})
    return items


@router.post("/moderation/complaints/{complaint_id}/approve")
async def approve_moderated_complaint(complaint_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    if not authorize(db, user, "MODERATE_CONTENT", "COMPLAINT", complaint_id):
        db.commit()
        raise HTTPException(status_code=403, detail="Role cannot moderate complaints")
    complaint = db.get(Complaint, complaint_id)
    if not complaint:
        raise HTTPException(status_code=404, detail="Complaint not found")
    result = run_complaint_pipeline(db, complaint, complaint.space_code, force_approved=True)
    db.commit()
    if result.get("twin_mutation"):
        await ws_hub.broadcast_all("TWIN_STATE_MUTATED", result["twin_mutation"])
    await ws_hub.broadcast("portal", "COMPLAINT_UPDATED", {"complaint": complaint_dict(complaint)})
    return {"complaint": complaint_dict(complaint), **result}


@router.post("/vault/{vault_token}/unseal")
def break_glass_unseal(vault_token: str, payload: VaultUnsealRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    vault = db.scalar(select(IdentityVault).where(IdentityVault.vault_token == vault_token))
    if not vault:
        raise HTTPException(status_code=404, detail="Vault record not found")
    context = {"policy_clause": payload.policy_clause, "justification_reason": payload.justification_reason}
    if not authorize(db, user, "BREAK_GLASS_UNSEAL", "IDENTITY_VAULT", vault_token, context):
        db.commit()
        raise HTTPException(status_code=403, detail="Only System Administrator may unseal identities")
    audit_entry = append_audit_log(db, actor=user, action="BREAK_GLASS_UNSEAL", resource_type="IDENTITY_VAULT", resource_id=vault_token, outcome="BREAK_GLASS", rule_fired=payload.policy_clause, reason=payload.justification_reason, context={"target_entity_type": vault.target_entity_type, "target_entity_id": vault.target_entity_id})
    identity = unseal_identity(vault.encrypted_identity_blob)
    vault.unsealed_at = datetime.now(timezone.utc)
    vault.unsealed_by_user_id = user.id
    db.commit()
    return {"vault_token": vault_token, "identity": identity, "unsealed_at": vault.unsealed_at, "policy_clause": payload.policy_clause, "audit_entry_id": audit_entry.id}


@router.get("/incidents")
def incidents(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    require_admin(user)
    rows = db.scalars(select(Incident).order_by(Incident.created_at.desc())).all()
    return [{"id": row.id, "incident_number": row.incident_number, "title": row.title, "correlation_type": row.correlation_type, "root_cause_key": row.root_cause_key, "root_cause": row.root_cause_key, "distribution_board_code": row.root_cause_key, "severity": row.severity, "status": row.status, "ai_summary_text": row.ai_summary_text, "affected_rooms": row.affected_rooms_csv.split(",") if row.affected_rooms_csv else [], "affected_space_codes": row.affected_rooms_csv.split(",") if row.affected_rooms_csv else [], "affected_classes": row.affected_classes_csv.split(",") if row.affected_classes_csv else [], "affected_class_count": len(row.affected_classes_csv.split(",")) if row.affected_classes_csv else 0, "total_students_impacted": row.total_students_impacted, "affected_student_count": row.total_students_impacted, "chronic_replacement_advised": row.chronic_replacement_advised, "created_at": row.created_at} for row in rows]


@router.get("/work-orders")
def work_orders(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    require_admin(user)
    return [work_order_dict(row) for row in db.scalars(select(WorkOrder).order_by(WorkOrder.created_at.desc())).all()]


@router.get("/inventory")
def inventory(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    require_admin(user)
    rows = db.scalars(select(InventoryItem).order_by(InventoryItem.sku_code)).all()
    return [{"id": row.id, "sku_code": row.sku_code, "name": row.part_name, "part_name": row.part_name, "category": row.category, "unit": "units", "on_hand_qty": row.on_hand_qty, "reserved_qty": row.reserved_qty, "available_qty": row.on_hand_qty - row.reserved_qty, "reorder_level": row.reorder_threshold, "reorder_threshold": row.reorder_threshold, "unit_cost_inr": row.unit_cost_inr, "lead_time_hours": row.lead_time_hours} for row in rows]


@router.get("/sla")
def sla_clocks(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    require_admin(user)
    rows = db.scalars(select(SlaClock).order_by(SlaClock.id.desc())).all()
    active_work_order_ids = set(
        db.scalars(select(WorkOrder.id).where(WorkOrder.status.notin_({"RESOLVED", "CLOSED", "COMPLETED"}))).all()
    )
    rows = [
        row for row in rows
        if row.target_type != "WORK_ORDER" or row.target_id in active_work_order_ids
    ]
    result = []
    for row in rows:
        remaining = max(0, row.resolution_target_mins - row.elapsed_active_mins)
        result.append({"id": row.id, "target_type": row.target_type, "target_id": row.target_id, "work_order_id": row.target_id if row.target_type == "WORK_ORDER" else None, "space_code": row.space_code, "urgency": row.urgency, "priority": row.urgency, "target_minutes": row.resolution_target_mins, "response_target_mins": row.response_target_mins, "resolution_target_mins": row.resolution_target_mins, "elapsed_active_minutes": row.elapsed_active_mins, "elapsed_active_mins": row.elapsed_active_mins, "remaining_minutes": remaining, "progress_percent": round(min(100, row.elapsed_active_mins / row.resolution_target_mins * 100), 1), "is_paused": row.is_paused, "pause_reason": row.pause_reason, "breach_state": row.breach_state, "current_escalation_tier": row.current_escalation_tier, "last_tick_at": row.last_tick_at})
    return result


@router.get("/staff")
def staff(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    require_admin(user)
    rows = db.scalars(select(StaffProfile).order_by(StaffProfile.staff_code)).all()
    return [{"staff_code": row.staff_code, "full_name": row.user.full_name, "staff_category": row.staff_category, "assigned_class_code": row.assigned_class_code, "assigned_lab_code": row.assigned_lab_code, "primary_skill": row.primary_skill, "skill_proficiency": row.skill_proficiency, "risk_clearance": row.risk_clearance, "hourly_cost_inr": row.hourly_cost_inr, "shift_code": row.shift_code, "is_on_shift": row.is_on_shift, "is_on_leave": row.is_on_leave, "current_active_jobs": row.current_active_jobs, "max_concurrent_jobs": row.max_concurrent_jobs, "current_block_location": row.current_block_location} for row in rows]
