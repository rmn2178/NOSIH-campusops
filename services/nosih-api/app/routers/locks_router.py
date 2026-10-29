from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.engines.resource_lock import claim_resource_lock, heartbeat_resource_lock, release_resource_lock
from app.models import ResourceLock, User

router = APIRouter(prefix="/api/locks", tags=["resource-locks"])
LOCK_ROLES = {"MAINTENANCE", "INCIDENT_MANAGER", "FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "SYSTEM_ADMIN"}


def _require_operator(current_user: User) -> None:
    if current_user.role not in LOCK_ROLES:
        raise HTTPException(status_code=403, detail="Administrator role required to manage resource locks")


class LockRequest(BaseModel):
    resource_type: str | None = None
    resource_id: str | None = None
    lock_id: int | str | None = None


def _target(db: Session, payload: LockRequest) -> tuple[str, str]:
    if payload.lock_id is not None:
        try:
            lock = db.get(ResourceLock, int(payload.lock_id))
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="lock_id must be a lock identifier")
        if not lock:
            raise HTTPException(status_code=404, detail="Resource lock not found")
        return lock.resource_type, lock.resource_id
    if not payload.resource_type or not payload.resource_id:
        raise HTTPException(status_code=422, detail="resource_type and resource_id, or lock_id, are required")
    return payload.resource_type, payload.resource_id


def _finish(db: Session, callback):
    try:
        result = callback()
        db.commit()
        return result
    except HTTPException:
        db.commit()
        raise
    except Exception:
        db.rollback()
        raise


@router.post("/claim")
def claim_lock(
    payload: LockRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def claim():
        _require_operator(current_user)
        resource_type, resource_id = _target(db, payload)
        return claim_resource_lock(db, current_user, resource_type, resource_id)
    return _finish(db, claim)


@router.post("/release")
def release_lock(
    payload: LockRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def release():
        _require_operator(current_user)
        resource_type, resource_id = _target(db, payload)
        return release_resource_lock(db, current_user, resource_type, resource_id)
    return _finish(db, release)


@router.post("/heartbeat")
def heartbeat_lock(
    payload: LockRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def heartbeat():
        _require_operator(current_user)
        resource_type, resource_id = _target(db, payload)
        return heartbeat_resource_lock(db, current_user, resource_type, resource_id)
    return _finish(db, heartbeat)
