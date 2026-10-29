import json
import math
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Complaint


def cosine_similarity(left: str, right: str) -> float:
    stop = {"the", "a", "an", "is", "are", "in", "of", "and", "not", "working"}
    left_counts = Counter(word for word in re.findall(r"[a-z0-9]+", left.lower()) if word not in stop)
    right_counts = Counter(word for word in re.findall(r"[a-z0-9]+", right.lower()) if word not in stop)
    if not left_counts or not right_counts:
        return 0.0
    common = set(left_counts) & set(right_counts)
    numerator = sum(left_counts[word] * right_counts[word] for word in common)
    denominator = math.sqrt(sum(value * value for value in left_counts.values())) * math.sqrt(sum(value * value for value in right_counts.values()))
    return numerator / denominator if denominator else 0.0


def asset_codes(complaint: Complaint) -> set[str]:
    extracted = json.loads(complaint.ai_extracted_json or "{}")
    return {code for asset in extracted.get("target_assets", []) for code in asset.get("asset_codes", [])}


def similarity(new_complaint: Complaint, candidate: Complaint) -> float:
    text_score = cosine_similarity(f"{new_complaint.title} {new_complaint.description}", f"{candidate.title} {candidate.description}")
    new_assets, candidate_assets = asset_codes(new_complaint), asset_codes(candidate)
    asset_score = len(new_assets & candidate_assets) / len(new_assets | candidate_assets) if new_assets or candidate_assets else 0.0
    return min(1.0, text_score * 0.7 + asset_score * 0.3)


def find_and_merge_duplicate(db: Session, complaint: Complaint) -> Complaint | None:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    candidates = db.scalars(
        select(Complaint).where(
            Complaint.id != complaint.id,
            Complaint.space_code == complaint.space_code,
            Complaint.moderation_status == "APPROVED",
            Complaint.status.in_(["OPEN", "TRIAGED", "IN_PROGRESS", "BLOCKED_PARTS"]),
            Complaint.created_at >= cutoff,
        )
    ).all()
    if not candidates:
        return None
    parent = max(candidates, key=lambda candidate: similarity(complaint, candidate))
    score = similarity(complaint, parent)
    if score < 0.78 and parent.category != complaint.category:
        return None
    complaint.status = "MERGED_DUPLICATE"
    complaint.parent_complaint_id = parent.id
    parent.affected_upvote_count += 1
    parent_extracted: dict[str, Any] = json.loads(parent.ai_extracted_json or "{}")
    merged_assets = {code for asset in parent_extracted.get("target_assets", []) for code in asset.get("asset_codes", [])}
    merged_assets.update(asset_codes(complaint))
    parent_extracted["merged_asset_codes"] = sorted(merged_assets)
    if complaint.image_url and not parent.image_url:
        parent.image_url = complaint.image_url
    parent.ai_extracted_json = json.dumps(parent_extracted)
    return parent
