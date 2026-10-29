import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.correlator import chronic_replacement_required
from app.models import Asset, BillBot, Canteen, Complaint, Incident, Lab, Room, SlaClock, WorkOrder

URGENCY_TARGETS = {"LOW": (240, 2880), "MEDIUM": (120, 1440), "HIGH": (30, 240), "CRITICAL": (10, 60)}


def _next_work_order_number(db: Session) -> str:
    count = len(db.scalars(select(WorkOrder.id)).all()) + 1
    return f"WO-2026-{count:04d}"


def propagate_complaint_to_twin(db: Session, complaint: Complaint) -> dict[str, Any]:
    extracted = json.loads(complaint.ai_extracted_json or "{}")
    asset_codes = [code for asset in extracted.get("target_assets", []) for code in asset.get("asset_codes", [])]
    chronic = any(chronic_replacement_required(db, complaint.space_code, code) for code in asset_codes)
    if chronic and complaint.linked_incident_id:
        incident = db.get(Incident, complaint.linked_incident_id)
        if incident:
            incident.chronic_replacement_advised = True
    if complaint.space_type == "ROOM":
        result = _propagate_room(db, complaint, extracted, asset_codes)
    elif complaint.space_type == "LAB":
        result = _propagate_lab(db, complaint, asset_codes)
    elif complaint.space_type == "BILL_BOT":
        result = _propagate_bill_bot(db, complaint, asset_codes)
    elif complaint.space_type == "CANTEEN":
        result = _propagate_canteen(db, complaint, asset_codes)
    else:
        raise ValueError(f"Unsupported space type {complaint.space_type}")
    work_order = db.scalar(select(WorkOrder).where(WorkOrder.complaint_id == complaint.id))
    if not work_order:
        work_order = WorkOrder(
            wo_number=_next_work_order_number(db),
            incident_id=complaint.linked_incident_id,
            complaint_id=complaint.id,
            space_code=complaint.space_code,
            target_asset_codes_json=json.dumps(asset_codes),
            required_skill=extracted.get("required_skill", "ELECTRICAL"),
            required_risk_clearance=extracted.get("required_risk_clearance", "STANDARD"),
            priority_score={"LOW": 25, "MEDIUM": 50, "HIGH": 80, "CRITICAL": 100}[complaint.urgency],
        )
        db.add(work_order)
        db.flush()
    response_mins, resolution_mins = URGENCY_TARGETS[complaint.urgency]
    sla = db.scalar(select(SlaClock).where(SlaClock.target_type == "WORK_ORDER", SlaClock.target_id == work_order.id))
    if not sla:
        db.add(SlaClock(target_type="WORK_ORDER", target_id=work_order.id, space_code=complaint.space_code, urgency=complaint.urgency, response_target_mins=response_mins, resolution_target_mins=resolution_mins))
    complaint.status = "TRIAGED"
    db.flush()
    return {**result, "space_code": complaint.space_code, "complaint_id": complaint.id, "ticket_number": complaint.ticket_number, "work_order_id": work_order.id, "chronic_replacement_advised": chronic}


def _propagate_room(db: Session, complaint: Complaint, extracted: dict[str, Any], asset_codes: list[str]) -> dict[str, Any]:
    room = db.scalar(select(Room).where(Room.code == complaint.space_code))
    if not room:
        raise ValueError(f"Unknown room {complaint.space_code}")
    severe = complaint.urgency in {"HIGH", "CRITICAL"} or len(asset_codes) > 1 or extracted.get("affects_active_class")
    room.visual_state = "FAULTY" if severe else "DEGRADED"
    for asset in db.scalars(select(Asset).where(Asset.asset_code.in_(asset_codes))).all():
        asset.status = "FAULTY"
        asset.failure_count_30d += 1
    alternates: list[dict[str, Any]] = []
    if severe:
        from app.engines.period_clock import get_clock
        from app.engines.room_conflict import evaluate_room_conflicts

        clock = get_clock()
        period = clock["active_period"] or 1
        conflict_result = evaluate_room_conflicts(db, room.code, clock["day_of_week"], period)
        alternates = conflict_result.get("available_alternates", [])[:3]
        extracted["alternate_rooms"] = alternates
        complaint.ai_extracted_json = json.dumps(extracted)
    return {"visual_state": room.visual_state, "alternate_rooms": alternates}


def _propagate_lab(db: Session, complaint: Complaint, asset_codes: list[str]) -> dict[str, Any]:
    lab = db.scalar(select(Lab).where(Lab.code == complaint.space_code))
    if not lab:
        raise ValueError(f"Unknown lab {complaint.space_code}")
    lab.visual_state = "FAULTY" if complaint.urgency in {"HIGH", "CRITICAL"} else "DEGRADED"
    for asset in db.scalars(select(Asset).where(Asset.asset_code.in_(asset_codes))).all():
        asset.status = "FAULTY"
        asset.failure_count_30d += 1
    return {"visual_state": lab.visual_state}


def _propagate_bill_bot(db: Session, complaint: Complaint, asset_codes: list[str]) -> dict[str, Any]:
    bot = db.scalar(select(BillBot).where(BillBot.code == complaint.space_code))
    if not bot:
        raise ValueError(f"Unknown bill bot {complaint.space_code}")
    if bot.visual_state == "HEALTHY" and bot.nearest_fallback_bot:
        fallback = bot.nearest_fallback_bot
        fallback.active_queue_count += bot.active_queue_count
        bot.active_queue_count = 0
        bot.rerouted_to_bot_code = fallback.code
    bot.visual_state = "FAULTY"
    if "out of paper" in complaint.description.lower() or "paper low" in complaint.description.lower():
        bot.paper_roll_pct = 0
    for asset in db.scalars(select(Asset).where(Asset.asset_code.in_(asset_codes))).all():
        asset.status = "FAULTY"
    return {"visual_state": bot.visual_state, "rerouted_to_bot_code": bot.rerouted_to_bot_code}


def _propagate_canteen(db: Session, complaint: Complaint, asset_codes: list[str]) -> dict[str, Any]:
    canteen = db.scalar(select(Canteen).where(Canteen.code == complaint.space_code))
    if not canteen:
        raise ValueError(f"Unknown canteen {complaint.space_code}")
    canteen.visual_state = "FAULTY" if complaint.urgency in {"HIGH", "CRITICAL"} else "DEGRADED"
    menu = json.loads(canteen.active_menu_json or "[]")
    disabled = set(json.loads(canteen.disabled_menu_items_json or "[]"))
    for item in menu:
        if item.lower() in complaint.description.lower():
            disabled.add(item)
    canteen.disabled_menu_items_json = json.dumps(sorted(disabled))
    for asset in db.scalars(select(Asset).where(Asset.asset_code.in_(asset_codes))).all():
        asset.status = "FAULTY"
    return {"visual_state": canteen.visual_state, "disabled_menu_items": sorted(disabled)}
