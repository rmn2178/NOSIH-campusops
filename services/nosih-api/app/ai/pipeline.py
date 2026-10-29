import json
from typing import Any

from sqlalchemy.orm import Session

from app.ai.classifier import classify_fault
from app.ai.correlator import correlate_complaint
from app.ai.deduplicator import find_and_merge_duplicate
from app.ai.extractor import extract_entities
from app.ai.moderation import moderate_content
from app.engines.twin_propagator import propagate_complaint_to_twin
from app.models import Complaint


def run_complaint_pipeline(
    db: Session,
    complaint: Complaint,
    selected_space_code: str | None = None,
    selected_assets: list[dict] | None = None,
    *,
    force_approved: bool = False,
) -> dict[str, Any]:
    if force_approved:
        complaint.moderation_status = "APPROVED"
        complaint.moderation_reason = "Approved by a human moderator after review"
    else:
        moderation = moderate_content(f"{complaint.title}\n{complaint.description}")
        complaint.moderation_status = moderation.status
        complaint.moderation_reason = moderation.reason
        if moderation.status != "APPROVED":
            complaint.ai_extracted_json = json.dumps({"suggested_polite_rewrite": moderation.suggested_polite_rewrite})
            db.flush()
            return {"moderation_status": moderation.status, "reason": moderation.reason, "suggested_polite_rewrite": moderation.suggested_polite_rewrite, "twin_mutation": None}

    text = f"{complaint.title}\n{complaint.description}"
    extracted = extract_entities(text, selected_space_code or complaint.space_code)
    if selected_assets:
        grouped: dict[str, list[dict]] = {}
        for asset in selected_assets:
            grouped.setdefault(str(asset["asset_type"]), []).append(asset)
        extracted["target_assets"] = [
            {"asset_type": asset_type, "indices": [int(asset.get("slot_index", 1)) for asset in assets], "asset_codes": [str(asset["asset_code"]) for asset in assets]}
            for asset_type, assets in grouped.items()
        ]
    classification = classify_fault(text, extracted)
    extracted.update(classification)
    complaint.space_code = extracted.get("space_code") or complaint.space_code
    complaint.space_type = extracted.get("space_type") or complaint.space_type
    complaint.category = classification["category"]
    complaint.urgency = classification["urgency"]
    complaint.ai_extracted_json = json.dumps(extracted)
    complaint.missing_info_questions_json = json.dumps(extracted.get("missing_info_questions", []))
    db.flush()

    duplicate_parent = find_and_merge_duplicate(db, complaint)
    if duplicate_parent:
        db.flush()
        return {"moderation_status": "APPROVED", "extracted": extracted, "duplicate_of": duplicate_parent.ticket_number, "affected_count": duplicate_parent.affected_upvote_count, "twin_mutation": None}

    incident = correlate_complaint(db, complaint)
    mutation = propagate_complaint_to_twin(db, complaint)
    db.flush()
    return {"moderation_status": "APPROVED", "extracted": extracted, "duplicate_of": None, "incident_number": incident.incident_number if incident else None, "twin_mutation": mutation}
