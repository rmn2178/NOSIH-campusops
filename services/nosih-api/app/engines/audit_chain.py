import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AuditLog, User

GENESIS_HASH = "0" * 64

ACTION_ROLES: dict[str, set[str]] = {
    "BREAK_GLASS_UNSEAL": {"SYSTEM_ADMIN"},
    "ROOM_RELOCATE": {"INCIDENT_MANAGER", "FACILITIES_ADMIN", "SYSTEM_ADMIN"},
    "ASSIGN_STAFF": {"INCIDENT_MANAGER", "FACILITIES_ADMIN", "SYSTEM_ADMIN"},
    "RESERVE_PARTS": {"MAINTENANCE", "INCIDENT_MANAGER", "FACILITIES_ADMIN", "SYSTEM_ADMIN"},
    "APPROVE_PURCHASE": {"FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "SYSTEM_ADMIN"},
    "OVERRIDE_PURCHASE": {"FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "INCIDENT_MANAGER", "SYSTEM_ADMIN"},
    "RECEIVE_STOCK": {"FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "SYSTEM_ADMIN"},
    "MODERATE_CONTENT": {"INCIDENT_MANAGER", "SYSTEM_ADMIN"},
    "UPDATE_CLOCK": {"INCIDENT_MANAGER", "FACILITIES_ADMIN", "SYSTEM_ADMIN"},
}


def timestamp_text(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def calculate_row_hash(entry: AuditLog, prev_hash: str | None = None) -> str:
    payload = "|".join(
        [
            entry.prev_hash if prev_hash is None else prev_hash,
            timestamp_text(entry.timestamp),
            entry.actor_email,
            entry.actor_role,
            entry.action,
            entry.resource_type,
            entry.resource_id,
            entry.outcome,
            entry.rule_fired,
            entry.reason,
        ]
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def append_audit_log(
    db: Session,
    *,
    actor: User | None,
    action: str,
    resource_type: str,
    resource_id: str | int,
    outcome: str = "ALLOWED",
    rule_fired: str = "",
    reason: str = "",
    context: dict[str, Any] | None = None,
    timestamp: datetime | None = None,
) -> AuditLog:
    previous = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).first()
    entry = AuditLog(
        timestamp=timestamp or datetime.now(timezone.utc),
        actor_user_id=actor.id if actor else None,
        actor_email=actor.email if actor else "system@nosih.edu.in",
        actor_role=actor.role if actor else "SYSTEM",
        action=action,
        resource_type=resource_type,
        resource_id=str(resource_id),
        outcome=outcome,
        rule_fired=rule_fired,
        reason=reason,
        context_json=json.dumps(context or {}, sort_keys=True, separators=(",", ":")),
        prev_hash=previous.row_hash if previous else GENESIS_HASH,
    )
    entry.row_hash = calculate_row_hash(entry)
    db.add(entry)
    db.flush()
    return entry


def verify_audit_chain(db: Session) -> dict[str, Any]:
    previous_hash = GENESIS_HASH
    entries = db.scalars(select(AuditLog).order_by(AuditLog.id)).all()
    for entry in entries:
        if entry.prev_hash != previous_hash or entry.row_hash != calculate_row_hash(entry):
            return {
                "verified": False,
                "total_entries": len(entries),
                "head_hash": entries[-1].row_hash if entries else GENESIS_HASH,
                "invalid_entry_id": entry.id,
            }
        previous_hash = entry.row_hash
    return {
        "verified": True,
        "total_entries": len(entries),
        "head_hash": previous_hash,
    }


def authorize(
    db: Session,
    user: User,
    action: str,
    resource_type: str,
    resource_id: str | int,
    context: dict[str, Any] | None = None,
) -> bool:
    allowed = user.is_active and user.role in ACTION_ROLES.get(action, set())
    append_audit_log(
        db,
        actor=user,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        outcome="ALLOWED" if allowed else "REJECTED",
        rule_fired="ROLE_AUTHORIZED" if allowed else "RBAC_ROLE_NOT_PERMITTED",
        reason="Authorized by role policy" if allowed else f"Role {user.role} cannot perform {action}",
        context=context,
    )
    return allowed
