import hashlib
import hmac
import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.ai.classifier import classify_fault
from app.ai.moderation import moderate_content
from app.ai.pipeline import run_complaint_pipeline
from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.engines.anonymity_vault import create_identity_vault, public_identity_label, unseal_identity
from app.engines.twin_propagator import propagate_complaint_to_twin
from app.models import BillBot, Canteen, Complaint, ComplaintComment, ComplaintVote, IdentityVault, Lab, Room, WorkOrder
from app.models import User
from app.schemas.complaints import CommentCreate, ComplaintCreate, RewriteRequest, SupplementRequest
from app.serializers import comment_dict, complaint_dict
from app.ws_manager import ws_hub

router = APIRouter(prefix="/api/complaints", tags=["complaints"])


def resolve_space(db: Session, code: str) -> tuple[str, str, str | None, int | None]:
    normalized = code.strip().upper()
    room = db.scalar(select(Room).where((Room.code == normalized) | (Room.zero_index_alias == normalized)))
    if room:
        return "ROOM", room.code, room.code[0], int(room.code[1])
    lab = db.scalar(select(Lab).where(Lab.code == normalized))
    if lab:
        return "LAB", lab.code, "LAB_WING", 1
    canteen = db.scalar(select(Canteen).where(Canteen.code == normalized))
    if canteen:
        return "CANTEEN", canteen.code, "COURTYARD", None
    bot = db.scalar(select(BillBot).where(BillBot.code == normalized))
    if bot:
        return "BILL_BOT", bot.code, "COURTYARD", None
    raise HTTPException(status_code=422, detail=f"Unknown campus space {code}")


def next_ticket_number(db: Session) -> str:
    return f"CMP-2026-{(db.scalar(select(func.count(Complaint.id))) or 0) + 1:04d}"


@router.get("")
def list_complaints(
    db: Annotated[Session, Depends(get_db)],
    zone: str | None = None,
    complaint_status: str | None = Query(default=None, alias="status"),
    category: str | None = None,
    limit: int = Query(default=100, ge=1, le=200),
) -> list[dict[str, Any]]:
    query = select(Complaint).where(Complaint.moderation_status == "APPROVED")
    if complaint_status:
        query = query.where(Complaint.status == complaint_status)
    if category:
        query = query.where(Complaint.category == category)
    if zone and zone != "ALL":
        zone_values = {"BLOCK_A": ("ROOM", "A"), "BLOCK_B": ("ROOM", "B"), "BLOCK_C": ("ROOM", "C")}
        if zone in zone_values:
            space_type, building = zone_values[zone]
            query = query.where(Complaint.space_type == space_type, Complaint.building_code == building)
        else:
            type_map = {"LABS": "LAB", "CANTEENS": "CANTEEN", "BILL_BOTS": "BILL_BOT"}
            if zone in type_map:
                query = query.where(Complaint.space_type == type_map[zone])
    complaints = db.scalars(query.order_by(Complaint.created_at.desc()).limit(limit)).all()
    return [complaint_dict(item) for item in complaints]


@router.get("/mine")
def my_complaints(db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> list[dict[str, Any]]:
    complaints = db.scalars(select(Complaint).where(Complaint.reporter_user_id == user.id).order_by(Complaint.created_at.desc())).all()
    return [complaint_dict(item) for item in complaints]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_complaint(payload: ComplaintCreate, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    if user.role not in {"STUDENT", "FACULTY", "LAB_STAFF"}:
        raise HTTPException(status_code=403, detail="This portal accepts reports from students, faculty, and staff")
    space_type, space_code, building, floor = resolve_space(db, payload.space_code)
    complaint = Complaint(
        ticket_number=next_ticket_number(db),
        space_type=space_type,
        space_code=space_code,
        building_code=building,
        floor_number=floor,
        title=(payload.title or payload.description.strip().split("\n", 1)[0][:80]).strip(),
        description=payload.description.strip(),
        image_url=payload.image_url or (f"/uploads/{payload.photo_upload_id}" if payload.photo_upload_id else None),
        is_anonymous=payload.is_anonymous,
        reporter_user_id=None if payload.is_anonymous else user.id,
        public_reporter_label=public_identity_label(user, payload.is_anonymous),
        moderation_status="NEEDS_REWRITE",
        source_channel="WEB_PORTAL",
    )
    db.add(complaint)
    db.flush()
    if payload.is_anonymous:
        vault = create_identity_vault(db, user=user, target_entity_type="COMPLAINT", target_entity_id=complaint.id, client_timestamp=payload.client_timestamp)
        complaint.vault_token = vault.vault_token
    result = run_complaint_pipeline(db, complaint, space_code, payload.target_assets)
    db.commit()
    serialized = complaint_dict(complaint)
    response = {"complaint": serialized, "first_response": serialized["first_response"], "message": result.get("reason", "Complaint accepted"), **result}
    if result.get("twin_mutation"):
        await ws_hub.broadcast_all("TWIN_STATE_MUTATED", result["twin_mutation"])
    if complaint.moderation_status == "APPROVED":
        await ws_hub.broadcast("portal", "COMPLAINT_CREATED", {"complaint": complaint_dict(complaint)})
    return response


@router.get("/{complaint_id}")
def get_complaint(complaint_id: int, db: Annotated[Session, Depends(get_db)]) -> dict[str, Any]:
    complaint = db.get(Complaint, complaint_id)
    if not complaint or complaint.moderation_status != "APPROVED":
        raise HTTPException(status_code=404, detail="Complaint not found")
    return complaint_dict(complaint)


@router.post("/{complaint_id}/rewrite")
async def rewrite_complaint(complaint_id: int, payload: RewriteRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    complaint = db.get(Complaint, complaint_id)
    if not complaint:
        raise HTTPException(status_code=404, detail="Complaint not found")
    if complaint.moderation_status != "NEEDS_REWRITE":
        raise HTTPException(status_code=409, detail="This report does not require a rewrite")
    if complaint.is_anonymous:
        vault = db.scalar(select(IdentityVault).where(IdentityVault.vault_token == complaint.vault_token))
        if not vault or unseal_identity(vault.encrypted_identity_blob)["user_id"] != user.id:
            raise HTTPException(status_code=403, detail="Only the reporter can rewrite this submission")
    elif complaint.reporter_user_id != user.id:
        raise HTTPException(status_code=403, detail="Only the reporter can rewrite this submission")
    complaint.description = payload.description.strip()
    result = run_complaint_pipeline(db, complaint, complaint.space_code)
    db.commit()
    if result.get("twin_mutation"):
        await ws_hub.broadcast_all("TWIN_STATE_MUTATED", result["twin_mutation"])
    if complaint.moderation_status == "APPROVED":
        await ws_hub.broadcast("portal", "COMPLAINT_UPDATED", {"complaint": complaint_dict(complaint)})
    return {"complaint": complaint_dict(complaint), **result}


@router.post("/{complaint_id}/supplement")
async def supplement_complaint(complaint_id: int, payload: SupplementRequest, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    complaint = db.get(Complaint, complaint_id)
    if not complaint or complaint.moderation_status != "APPROVED":
        raise HTTPException(status_code=404, detail="Complaint not found")
    submitted_answers = payload.answer_map()
    answers = json.loads(complaint.missing_info_answers_json or "{}")
    allowed_questions = json.loads(complaint.missing_info_questions_json or "[]")
    if any(question not in allowed_questions for question in submitted_answers):
        raise HTTPException(status_code=422, detail="Answer does not match a requested follow-up question")
    answers.update(submitted_answers)
    complaint.missing_info_answers_json = json.dumps(answers)
    extracted = json.loads(complaint.ai_extracted_json or "{}")
    supplemental_text = " ".join(submitted_answers.values())
    classification = classify_fault(f"{complaint.description}\n{supplemental_text}", extracted)
    extracted.update(classification)
    extracted["supplemental_answers"] = answers
    complaint.ai_extracted_json = json.dumps(extracted)
    complaint.category = classification["category"]
    complaint.urgency = classification["urgency"]
    work_order = db.scalar(select(WorkOrder).where(WorkOrder.complaint_id == complaint.id))
    if work_order:
        work_order.required_skill = classification["required_skill"]
        work_order.required_risk_clearance = classification["required_risk_clearance"]
        work_order.priority_score = {"LOW": 25, "MEDIUM": 50, "HIGH": 80, "CRITICAL": 100}[complaint.urgency]
    mutation = propagate_complaint_to_twin(db, complaint)
    db.commit()
    await ws_hub.broadcast_all("TWIN_STATE_MUTATED", mutation)
    serialized = complaint_dict(complaint)
    await ws_hub.broadcast("portal", "COMPLAINT_UPDATED", {"complaint": serialized})
    return {"complaint": serialized, "first_response": serialized["first_response"], "twin_mutation": mutation}


@router.post("/{complaint_id}/vote")
def vote_complaint(complaint_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    complaint = db.get(Complaint, complaint_id)
    if not complaint or complaint.moderation_status != "APPROVED":
        raise HTTPException(status_code=404, detail="Complaint not found")
    voter_hash = hmac.new(settings.jwt_secret.encode(), f"vote:{user.id}".encode(), hashlib.sha256).hexdigest()
    if db.scalar(select(ComplaintVote).where(ComplaintVote.complaint_id == complaint.id, ComplaintVote.voter_rate_limit_hash == voter_hash)):
        raise HTTPException(status_code=409, detail="You already confirmed this fault")
    db.add(ComplaintVote(complaint_id=complaint.id, voter_rate_limit_hash=voter_hash))
    complaint.affected_upvote_count += 1
    db.commit()
    return {"complaint_id": complaint.id, "affected_upvote_count": complaint.affected_upvote_count, "complaint": complaint_dict(complaint)}


@router.post("/{complaint_id}/affected")
def affected_complaint(complaint_id: int, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    vote_complaint(complaint_id, db, user)
    complaint = db.get(Complaint, complaint_id)
    return complaint_dict(complaint) if complaint else {}


@router.get("/{complaint_id}/comments")
def list_comments(complaint_id: int, db: Annotated[Session, Depends(get_db)]) -> list[dict[str, Any]]:
    comments = db.scalars(select(ComplaintComment).where(ComplaintComment.complaint_id == complaint_id, ComplaintComment.moderation_status == "APPROVED").order_by(ComplaintComment.created_at)).all()
    return [comment_dict(item) for item in comments]


@router.post("/{complaint_id}/comments", status_code=status.HTTP_201_CREATED)
async def create_comment(complaint_id: int, payload: CommentCreate, db: Annotated[Session, Depends(get_db)], user: Annotated[User, Depends(get_current_user)]) -> dict[str, Any]:
    complaint = db.get(Complaint, complaint_id)
    if not complaint or complaint.moderation_status != "APPROVED":
        raise HTTPException(status_code=404, detail="Complaint not found")
    moderation = moderate_content(payload.body)
    comment = ComplaintComment(
        complaint_id=complaint.id,
        body=payload.body.strip(),
        is_anonymous=payload.is_anonymous,
        author_user_id=None if payload.is_anonymous else user.id,
        public_author_label=public_identity_label(user, payload.is_anonymous),
        author_role_badge=user.role,
        moderation_status=moderation.status,
    )
    db.add(comment)
    db.flush()
    if payload.is_anonymous:
        vault = create_identity_vault(db, user=user, target_entity_type="COMMENT", target_entity_id=comment.id)
        comment.vault_token = vault.vault_token
    db.commit()
    if moderation.status == "APPROVED":
        await ws_hub.broadcast("portal", "COMMENT_CREATED", {"complaint_id": complaint.id, "comment": comment_dict(comment)})
    return {"comment": comment_dict(comment), "moderation_status": moderation.status, "reason": moderation.reason, "suggested_polite_rewrite": moderation.suggested_polite_rewrite}
