from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.engines.audit_chain import authorize
from app.engines.inventory_reservation import receive_stock
from app.engines.procurement_approval import approve_purchase_request, evaluate_approval_preflight, override_purchase_request
from app.models import User

router = APIRouter(prefix="/api/purchase-requests", tags=["procurement"])


class OverrideRequest(BaseModel):
    override_reason: str = Field(min_length=20)
    counter_sign_user_id: int | str


class ReceiveStockRequest(BaseModel):
    quantity_received: int | None = Field(default=None, gt=0)


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


def _authorize(db: Session, user: User, action: str, pr_id: int) -> None:
    if not authorize(db, user, action, "PURCHASE_REQUEST", pr_id):
        raise HTTPException(status_code=403, detail=f"Role {user.role} cannot perform {action}")


@router.get("/{pr_id}/approval-preflight")
def approval_preflight(
    pr_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return evaluate_approval_preflight(db, current_user, pr_id)


@router.post("/{pr_id}/approve")
def approve(
    pr_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "APPROVE_PURCHASE", pr_id)
        return approve_purchase_request(db, current_user, pr_id)

    return _finish(db, execute)


@router.post("/{pr_id}/override")
def override(
    pr_id: int,
    payload: OverrideRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "OVERRIDE_PURCHASE", pr_id)
        try:
            counter_sign_user_id = int(payload.counter_sign_user_id)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="counter_sign_user_id must be a numeric user id")
        return override_purchase_request(
            db, current_user, pr_id, payload.override_reason, counter_sign_user_id
        )

    return _finish(db, execute)


@router.post("/{pr_id}/receive-stock")
def receive_purchase_stock(
    pr_id: int,
    payload: ReceiveStockRequest | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    def execute():
        _authorize(db, current_user, "RECEIVE_STOCK", pr_id)
        return receive_stock(db, pr_id, payload.quantity_received if payload else None, user=current_user)

    return _finish(db, execute)
