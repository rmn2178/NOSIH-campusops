from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.audit_chain import append_audit_log
from app.models import ResourceLock, User

LOCK_TTL_SECONDS = 300


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def sweep_expired_locks(db: Session, *, now: datetime | None = None) -> int:
    """Remove expired claims before every lock operation."""
    current_time = now or _utcnow()
    expired = db.scalars(select(ResourceLock).where(ResourceLock.expires_at <= current_time)).all()
    for lock in expired:
        db.delete(lock)
    if expired:
        db.flush()
    return len(expired)


def lock_details(lock: ResourceLock, *, now: datetime | None = None) -> dict[str, Any]:
    current_time = _as_utc(now or _utcnow())
    acquired_at = _as_utc(lock.acquired_at)
    expires_at = _as_utc(lock.expires_at)
    return {
        "id": str(lock.id),
        "resource_type": lock.resource_type,
        "resource_id": lock.resource_id,
        "locked_by_user_id": lock.holder_user_id,
        "locked_by_name": lock.holder_name,
        "locked_by_role": lock.holder_role,
        "acquired_seconds_ago": max(0, int((current_time - acquired_at).total_seconds())),
        "expires_in_seconds": max(0, int((expires_at - current_time).total_seconds())),
        "acquired_at": acquired_at.isoformat(),
        "expires_at": expires_at.isoformat(),
    }


def claim_resource_lock(
    db: Session,
    user: User,
    resource_type: str,
    resource_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Claim or renew a resource for exactly five minutes.

    The row-level lock serializes updates on databases that support SELECT FOR
    UPDATE; the unique (resource_type, resource_id) key protects inserts.
    """
    current_time = _as_utc(now or _utcnow())
    resource_type = resource_type.strip().upper()
    resource_id = resource_id.strip()
    if not resource_type or not resource_id:
        raise HTTPException(status_code=422, detail="resource_type and resource_id are required")

    sweep_expired_locks(db, now=current_time)
    lock = db.scalars(
        select(ResourceLock)
        .where(ResourceLock.resource_type == resource_type, ResourceLock.resource_id == resource_id)
        .with_for_update()
    ).first()
    if lock and lock.holder_user_id != user.id:
        detail = lock_details(lock, now=current_time)
        append_audit_log(
            db,
            actor=user,
            action="CLAIM_RESOURCE_LOCK",
            resource_type=resource_type,
            resource_id=resource_id,
            outcome="REJECTED",
            rule_fired="RESOURCE_LOCK_HELD_BY_ANOTHER_USER",
            reason=f"Resource is held by {lock.holder_name} ({lock.holder_role})",
            context=detail,
        )
        raise HTTPException(status_code=409, detail=detail)

    expires_at = current_time + timedelta(seconds=LOCK_TTL_SECONDS)
    if lock:
        lock.holder_name = user.full_name
        lock.holder_role = user.role
        lock.acquired_at = current_time
        lock.expires_at = expires_at
        lock.heartbeat_at = current_time
    else:
        lock = ResourceLock(
            resource_type=resource_type,
            resource_id=resource_id,
            holder_user_id=user.id,
            holder_name=user.full_name,
            holder_role=user.role,
            acquired_at=current_time,
            expires_at=expires_at,
            heartbeat_at=current_time,
        )
        db.add(lock)
    db.flush()
    result = lock_details(lock, now=current_time)
    result["ttl_seconds"] = LOCK_TTL_SECONDS
    return result


def require_active_lock(
    db: Session,
    current_user: User,
    resource_type: str,
    resource_id: str,
    *,
    now: datetime | None = None,
    lock_id: str | int | None = None,
) -> ResourceLock:
    current_time = _as_utc(now or _utcnow())
    resource_type = resource_type.strip().upper()
    resource_id = resource_id.strip()
    sweep_expired_locks(db, now=current_time)
    lock = db.scalars(
        select(ResourceLock).where(
            ResourceLock.resource_type == resource_type,
            ResourceLock.resource_id == resource_id,
        )
    ).first()
    if lock is None:
        raise HTTPException(
            status_code=409,
            detail={
                "rule_fired": "ACTIVE_RESOURCE_LOCK_REQUIRED",
                "message": f"Claim {resource_type} {resource_id} before allocation",
            },
        )
    if lock.holder_user_id != current_user.id:
        detail = lock_details(lock, now=current_time)
        detail["rule_fired"] = "RESOURCE_LOCK_HELD_BY_ANOTHER_USER"
        raise HTTPException(status_code=409, detail=detail)
    if _as_utc(lock.expires_at) <= current_time:
        db.delete(lock)
        db.flush()
        raise HTTPException(status_code=409, detail="The resource lock has expired; claim it again")
    if lock_id is not None and str(lock.id) != str(lock_id):
        raise HTTPException(status_code=409, detail="The supplied lock_id does not match the active lock")
    return lock


def release_resource_lock(
    db: Session,
    user: User,
    resource_type: str,
    resource_id: str,
) -> dict[str, Any]:
    resource_type = resource_type.strip().upper()
    resource_id = resource_id.strip()
    sweep_expired_locks(db)
    lock = db.scalars(
        select(ResourceLock)
        .where(ResourceLock.resource_type == resource_type, ResourceLock.resource_id == resource_id)
        .with_for_update()
    ).first()
    if lock is None:
        return {"released": False, "resource_type": resource_type, "resource_id": resource_id}
    if lock.holder_user_id != user.id:
        raise HTTPException(status_code=403, detail="Only the lock holder can release this resource")
    db.delete(lock)
    db.flush()
    return {"released": True, "resource_type": resource_type, "resource_id": resource_id}


def heartbeat_resource_lock(
    db: Session,
    user: User,
    resource_type: str,
    resource_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    current_time = _as_utc(now or _utcnow())
    lock = require_active_lock(db, user, resource_type, resource_id, now=current_time)
    lock.heartbeat_at = current_time
    lock.expires_at = current_time + timedelta(seconds=LOCK_TTL_SECONDS)
    db.flush()
    result = lock_details(lock, now=current_time)
    result["ttl_seconds"] = LOCK_TTL_SECONDS
    return result


claim_lock = claim_resource_lock
release_lock = release_resource_lock
heartbeat_lock = heartbeat_resource_lock
