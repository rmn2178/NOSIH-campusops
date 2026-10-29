import json
from typing import Any

from app.models import Complaint, ComplaintComment, PurchaseRequest, User, WorkOrder


def user_dict(user: User, home_room_code: str | None = None, section_letter: str | None = None) -> dict[str, Any]:
    department_labels = {"AIDS": "AI&DS", "CYBER": "Cyber Security"}
    academic_role = f"YEAR_{user.year_number}" if user.role == "STUDENT" and user.year_number else "FACULTY_STAFF"
    role = "MAINTENANCE_TECHNICIAN" if user.role == "MAINTENANCE" else user.role
    return {"id": user.id, "email": user.email, "full_name": user.full_name, "role": role, "department_code": user.department_code, "department": department_labels.get(user.department_code or "", user.department_code), "academic_role": academic_role, "year_number": user.year_number, "class_code": user.class_code, "home_room_code": home_room_code, "section_letter": section_letter, "section": section_letter, "staff_code": user.staff_profile.staff_code if user.staff_profile else None}


def complaint_dict(complaint: Complaint, include_private: bool = False) -> dict[str, Any]:
    extracted = json.loads(complaint.ai_extracted_json or "{}")
    target_assets = []
    for asset in extracted.get("target_assets", []):
        for code in asset.get("asset_codes", []):
            try:
                slot = int(code.rsplit("-", 1)[-1])
            except ValueError:
                slot = 1
            target_assets.append({"asset_code": code, "asset_type": asset.get("asset_type", ""), "slot_index": slot})
    sla_targets = {"LOW": 2880, "MEDIUM": 1440, "HIGH": 240, "CRITICAL": 60}
    status = "IN_PROGRESS" if complaint.status == "TRIAGED" else complaint.status
    twin_state = "HEALTHY" if complaint.status == "RESOLVED" else "BLOCKED_PARTS" if complaint.status == "BLOCKED_PARTS" else "FAULTY" if complaint.urgency in {"HIGH", "CRITICAL"} else "DEGRADED"
    first_response = {
        "space_code": complaint.space_code,
        "block_floor": f"{complaint.building_code} / Floor {complaint.floor_number}" if complaint.floor_number else complaint.building_code,
        "target_assets": target_assets,
        "category": complaint.category or "ELECTRICAL",
        "urgency": complaint.urgency,
        "sla_target_minutes": sla_targets[complaint.urgency],
        "missing_info_questions": json.loads(complaint.missing_info_questions_json or "[]"),
        "merged_duplicate": complaint.parent_complaint_id is not None,
        "parent_complaint_id": complaint.parent_complaint_id,
        "parent_ticket_number": complaint.parent_complaint.ticket_number if complaint.parent_complaint else None,
        "affected_count": complaint.affected_upvote_count,
    }
    data = {
        "id": complaint.id,
        "ticket_number": complaint.ticket_number,
        "space_type": complaint.space_type,
        "space_code": complaint.space_code,
        "building_code": complaint.building_code,
        "floor_number": complaint.floor_number,
        "title": complaint.title,
        "description": complaint.description,
        "image_url": complaint.image_url,
        "is_anonymous": complaint.is_anonymous,
        "public_reporter_label": complaint.public_reporter_label,
        "moderation_status": complaint.moderation_status,
        "moderation_reason": complaint.moderation_reason,
        "category": complaint.category,
        "urgency": complaint.urgency,
        "status": complaint.status,
        "parent_complaint_id": complaint.parent_complaint_id,
        "affected_upvote_count": complaint.affected_upvote_count,
        "linked_incident_id": complaint.linked_incident_id,
        "source_channel": complaint.source_channel,
        "ai_extracted": json.loads(complaint.ai_extracted_json or "{}"),
        "missing_info_questions": json.loads(complaint.missing_info_questions_json or "[]"),
        "missing_info_answers": json.loads(complaint.missing_info_answers_json or "{}"),
        "created_at": complaint.created_at,
        "updated_at": complaint.updated_at,
        "space_kind": "CLASSROOM" if complaint.space_type == "ROOM" else complaint.space_type,
        "twin_state": twin_state,
        "reporter_label": complaint.public_reporter_label,
        "photo_url": complaint.image_url,
        "target_assets": target_assets,
        "affected_count": complaint.affected_upvote_count,
        "viewer_has_voted": False,
        "comment_count": len(complaint.comments),
        "sla_target_minutes": sla_targets[complaint.urgency],
        "sla_breach_state": None,
        "status": status,
        "first_response": first_response,
    }
    if include_private:
        data.update(reporter_user_id=complaint.reporter_user_id, vault_token=complaint.vault_token)
    return data


def comment_dict(comment: ComplaintComment, include_private: bool = False) -> dict[str, Any]:
    data = {"id": comment.id, "complaint_id": comment.complaint_id, "body": comment.body, "is_anonymous": comment.is_anonymous, "public_author_label": comment.public_author_label, "author_label": comment.public_author_label, "author_role_badge": comment.author_role_badge, "moderation_status": comment.moderation_status, "created_at": comment.created_at}
    if include_private:
        data.update(author_user_id=comment.author_user_id, vault_token=comment.vault_token)
    return data


def work_order_dict(work_order: WorkOrder) -> dict[str, Any]:
    priority = "CRITICAL" if work_order.priority_score >= 95 else "HIGH" if work_order.priority_score >= 75 else "MEDIUM" if work_order.priority_score >= 40 else "LOW"
    status = "OPEN" if work_order.status == "PENDING_ASSIGNMENT" else "RESOLVED" if work_order.status == "COMPLETED" else work_order.status
    return {"id": work_order.id, "wo_number": work_order.wo_number, "work_order_number": work_order.wo_number, "incident_id": work_order.incident_id, "complaint_id": work_order.complaint_id, "space_code": work_order.space_code, "title": work_order.complaint.title if work_order.complaint else f"{work_order.required_skill} maintenance", "description": work_order.complaint.description if work_order.complaint else None, "target_asset_codes": json.loads(work_order.target_asset_codes_json or "[]"), "required_skill": work_order.required_skill, "required_risk_clearance": work_order.required_risk_clearance, "priority_score": work_order.priority_score, "priority": priority, "assigned_staff_code": work_order.assigned_staff_code, "assigned_staff_name": work_order.assigned_staff_code, "assignment_score_breakdown": json.loads(work_order.assignment_score_breakdown_json or "{}"), "status": status, "reassignment_count": work_order.reassignment_count, "last_reassignment_reason": work_order.last_reassignment_reason, "created_at": work_order.created_at, "completed_at": work_order.completed_at}


def purchase_request_dict(pr: PurchaseRequest) -> dict[str, Any]:
    return {"id": pr.id, "pr_number": pr.pr_number, "linked_work_order_id": pr.linked_work_order_id, "work_order_id": pr.linked_work_order_id, "department_code": pr.department_code, "sku_code": pr.sku_code, "quantity_requested": pr.quantity_requested, "unit_cost_inr": pr.unit_cost_inr, "total_cost_inr": pr.total_cost_inr, "requested_by_user_id": pr.requested_by_user_id, "requested_by_name": pr.requester.full_name if pr.requester else f"User {pr.requested_by_user_id}", "status": "RECEIVED" if pr.status == "STOCK_RECEIVED" else pr.status, "raw_status": pr.status, "items": [{"sku_code": pr.sku_code, "quantity": pr.quantity_requested, "unit_cost_inr": pr.unit_cost_inr}], "requires_dual_approval": pr.requires_dual_approval, "first_approver_user_id": pr.first_approver_user_id, "second_approver_user_id": pr.second_approver_user_id, "override_reason": pr.override_reason, "created_at": pr.created_at}
