import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.pipeline import run_complaint_pipeline
from app.auth import get_current_user
from app.database import get_db
from app.models import Complaint, NotificationLog, User

router = APIRouter(prefix="/api/integrations", tags=["external-integrations"])


class InboundEmailRequest(BaseModel):
    from_email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    subject: str = Field(min_length=1)
    body: str = Field(min_length=1)


def _next_complaint_number(db: Session) -> str:
    prefix = f"CMP-{datetime.now().year}-"
    values = db.scalars(select(Complaint.ticket_number).where(Complaint.ticket_number.like(f"{prefix}%"))).all()
    maximum = 0
    for value in values:
        try:
            maximum = max(maximum, int(value.rsplit("-", 1)[1]))
        except (IndexError, ValueError):
            continue
    return f"{prefix}{maximum + 1:04d}"


@router.post("/email/receive")
def receive_email(payload: InboundEmailRequest, db: Session = Depends(get_db)) -> dict:
    complaint = Complaint(
        ticket_number=_next_complaint_number(db),
        space_type="ROOM",
        space_code="UNKNOWN",
        title=payload.subject,
        description=payload.body,
        reporter_user_id=None,
        public_reporter_label=str(payload.from_email),
        source_channel="EMAIL",
        status="OPEN",
    )
    db.add(complaint)
    db.flush()
    pipeline_result = run_complaint_pipeline(db, complaint)
    reply = NotificationLog(
        channel="EMAIL",
        recipient=str(payload.from_email),
        subject=f"Re: {payload.subject} [{complaint.ticket_number}]",
        payload_json=json.dumps(
            {
                "event": "INBOUND_EMAIL_CONFIRMATION",
                "ticket_number": complaint.ticket_number,
                "complaint_id": complaint.id,
                "moderation_status": complaint.moderation_status,
                "pipeline_result": pipeline_result,
                "message": "Your report has been received by NOSIH operations.",
            },
            sort_keys=True,
            default=str,
        ),
    )
    db.add(reply)
    db.commit()
    return {
        "received": True,
        "complaint_id": complaint.id,
        "ticket_number": complaint.ticket_number,
        "moderation_status": complaint.moderation_status,
        "pipeline_result": pipeline_result,
        "confirmation_notification_id": reply.id,
    }


@router.get("/notifications")
def notifications(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    if current_user.role not in {"INCIDENT_MANAGER", "FACILITIES_ADMIN", "PROCUREMENT_APPROVER", "SYSTEM_ADMIN"}:
        raise HTTPException(status_code=403, detail="Administrator role required")
    records = db.scalars(select(NotificationLog).order_by(NotificationLog.created_at.desc(), NotificationLog.id.desc())).all()
    result = []
    for record in records:
        try:
            notification_payload = json.loads(record.payload_json)
        except json.JSONDecodeError:
            notification_payload = record.payload_json
        result.append(
            {
                "id": record.id,
                "channel": record.channel,
                "recipient": record.recipient,
                "subject": record.subject,
                "payload": notification_payload,
                "delivery_status": record.delivery_status,
                "status": record.delivery_status,
                "created_at": record.created_at.isoformat(),
            }
        )
    return result
