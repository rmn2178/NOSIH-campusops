from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.engines.audit_chain import verify_audit_chain
from app.models import User

router = APIRouter(prefix="/api/audit", tags=["audit"])


@router.get("/verify")
def verify(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    return verify_audit_chain(db)
