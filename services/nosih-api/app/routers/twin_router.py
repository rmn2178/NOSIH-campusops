"""Campus clock, digital-twin overview and detailed space inspector APIs."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.auth import get_current_user
from app.database import get_db
from app.engines.audit_chain import authorize
from app.engines.period_clock import get_clock, period_time_label, update_clock
from app.models import (
    Asset,
    BillBot,
    Canteen,
    Complaint,
    Incident,
    Lab,
    MaintenanceHistory,
    ResourceLock,
    Room,
    SlaClock,
    StaffProfile,
    StudentClass,
    TimetableSlot,
    User,
    WorkOrder,
)

router = APIRouter(tags=["twin"])

_ACTIVE_COMPLAINT_EXCLUSIONS = {"RESOLVED", "CLOSED", "REJECTED", "CANCELLED"}
_ACTIVE_WORK_ORDER_EXCLUSIONS = {"RESOLVED", "CLOSED", "COMPLETED", "CANCELLED"}
_SLA_SEVERITY = {
    None: 0,
    "HEALTHY": 1,
    "ON_TRACK": 1,
    "PAUSED": 1,
    "WARNING_75": 2,
    "BREACHED_100": 3,
    "BREACHED": 3,
}


class ClockPatch(BaseModel):
    day_of_week: str | None = None
    current_time: str | None = None

    @field_validator("day_of_week")
    @classmethod
    def normalize_day(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip().upper()
        if normalized not in {"MON", "TUE", "WED", "THU", "FRI"}:
            raise ValueError("day_of_week must be MON, TUE, WED, THU or FRI")
        return normalized

    @field_validator("current_time")
    @classmethod
    def normalize_time(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            return datetime.strptime(value.strip(), "%H:%M").strftime("%H:%M")
        except ValueError as exc:
            raise ValueError("current_time must use 24-hour HH:MM format") from exc


def _json_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def _model_dict(instance: Any) -> dict[str, Any]:
    return {
        column.name: _json_value(getattr(instance, column.name))
        for column in instance.__table__.columns
    }


def _loads(value: str | None, fallback: Any) -> Any:
    try:
        return json.loads(value or "")
    except (TypeError, json.JSONDecodeError):
        return fallback


def _aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def _lock_dict(lock: ResourceLock | None, now: datetime) -> dict[str, Any] | None:
    if lock is None:
        return None
    expires_at = _aware(lock.expires_at)
    acquired_at = _aware(lock.acquired_at)
    return {
        **_model_dict(lock),
        "locked_by_user_id": lock.holder_user_id,
        "locked_by_name": lock.holder_name,
        "locked_by_role": lock.holder_role,
        "acquired_seconds_ago": max(0, int((now - acquired_at).total_seconds())),
        "expires_in_seconds": max(0, int((expires_at - now).total_seconds())),
    }


def _active_locks(db: Session) -> dict[tuple[str, str], ResourceLock]:
    now = datetime.now(timezone.utc)
    locks = (
        db.query(ResourceLock)
        .filter(ResourceLock.expires_at > now)
        .order_by(ResourceLock.acquired_at.desc())
        .all()
    )
    result: dict[tuple[str, str], ResourceLock] = {}
    for lock in locks:
        result.setdefault((lock.resource_type.upper(), lock.resource_id.upper()), lock)
    return result


def _active_fault_counts(db: Session) -> dict[str, int]:
    rows = (
        db.query(Complaint.space_code, func.count(Complaint.id))
        .filter(
            Complaint.moderation_status == "APPROVED",
            Complaint.status.notin_(_ACTIVE_COMPLAINT_EXCLUSIONS),
        )
        .group_by(Complaint.space_code)
        .all()
    )
    return {code: count for code, count in rows}


def _sla_states(db: Session) -> dict[str, str]:
    result: dict[str, str] = {}
    for clock in db.query(SlaClock).all():
        current = result.get(clock.space_code)
        if _SLA_SEVERITY.get(clock.breach_state, 1) > _SLA_SEVERITY.get(current, 0):
            result[clock.space_code] = clock.breach_state
    return result


def _space_type_for_kind(space_type: str) -> str:
    return "CLASSROOM" if space_type == "ROOM" else space_type


def _overview_item(
    space_type: str,
    space: Room | Lab | Canteen | BillBot,
    current_slots: dict[str, TimetableSlot],
    classes: dict[str, StudentClass],
    fault_counts: dict[str, int],
    sla_states: dict[str, str],
    locks: dict[tuple[str, str], ResourceLock],
) -> dict[str, Any]:
    slot = current_slots.get(space.code)
    student_class = classes.get(slot.class_code) if slot is not None else None
    item: dict[str, Any] = {
        "code": space.code,
        "space_type": space_type,
        "kind": _space_type_for_kind(space_type),
        "name": getattr(space, "name", space.code),
        "visual_state": space.visual_state,
        "is_occupied_now": slot is not None,
        "current_class_code": slot.class_code if slot is not None else None,
        "current_student_count": student_class.student_strength if student_class else 0,
        "active_fault_count": fault_counts.get(space.code, 0),
        "sla_breach_state": sla_states.get(space.code),
        "has_active_lock": (space_type, space.code) in locks,
        "x_pos": space.x_pos,
        "y_pos": space.y_pos,
        "z_pos": space.z_pos,
    }
    if isinstance(space, Room):
        item.update(
            {
                "building_code": space.floor.building.code,
                "block": space.floor.building.code,
                "floor_number": space.floor.floor_number,
                "floor": space.floor.floor_number,
                "room_capacity": space.capacity,
            }
        )
    elif isinstance(space, Lab):
        item["room_capacity"] = space.capacity
    elif isinstance(space, Canteen):
        item.update(
            {
                "queue_count": space.current_queue_length,
                "room_capacity": space.seating_capacity,
            }
        )
    else:
        item.update(
            {
                "queue_count": space.active_queue_count,
                "rerouted_to_bot_code": space.rerouted_to_bot_code,
                "paper_percent": space.paper_roll_pct,
            }
        )
    return item


@router.get("/api/clock")
def read_clock() -> dict[str, Any]:
    return get_clock()


@router.patch("/api/clock")
def patch_clock(
    payload: ClockPatch,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    if not authorize(db, current_user, "UPDATE_CLOCK", "CAMPUS_CLOCK", "current"):
        db.commit()
        raise HTTPException(status_code=403, detail=f"Role {current_user.role} cannot change the campus clock")
    try:
        result = update_clock(payload.day_of_week, payload.current_time)
    except ValueError as exc:
        db.commit()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.commit()
    return result


@router.get("/api/twin/overview")
def twin_overview(db: Session = Depends(get_db)) -> dict[str, Any]:
    clock = get_clock()
    current_slots: dict[str, TimetableSlot] = {}
    if clock["active_period"] is not None:
        slots = (
            db.query(TimetableSlot)
            .filter(
                TimetableSlot.day_of_week == clock["day_of_week"],
                TimetableSlot.period_number == clock["active_period"],
            )
            .all()
        )
        current_slots = {slot.effective_space_code: slot for slot in slots}

    classes = {item.class_code: item for item in db.query(StudentClass).all()}
    fault_counts = _active_fault_counts(db)
    sla_states = _sla_states(db)
    locks = _active_locks(db)
    spaces: list[dict[str, Any]] = []
    for space_type, query in (
        ("ROOM", db.query(Room).order_by(Room.code)),
        ("LAB", db.query(Lab).order_by(Lab.code)),
        ("CANTEEN", db.query(Canteen).order_by(Canteen.code)),
        ("BILL_BOT", db.query(BillBot).order_by(BillBot.code)),
    ):
        for space in query.all():
            spaces.append(
                _overview_item(
                    space_type,
                    space,
                    current_slots,
                    classes,
                    fault_counts,
                    sla_states,
                    locks,
                )
            )
    return {"spaces": spaces, "generated_at": datetime.now(timezone.utc).isoformat()}


def _resolve_space(
    db: Session, requested_code: str
) -> tuple[str, Room | Lab | Canteen | BillBot]:
    normalized = requested_code.strip().upper()
    room = (
        db.query(Room)
        .filter(or_(Room.code == normalized, Room.zero_index_alias == normalized))
        .first()
    )
    if room is not None:
        return "ROOM", room
    for space_type, model in (
        ("LAB", Lab),
        ("CANTEEN", Canteen),
        ("BILL_BOT", BillBot),
    ):
        space = db.query(model).filter(model.code == normalized).first()
        if space is not None:
            return space_type, space
    raise HTTPException(status_code=404, detail=f"Unknown space: {requested_code}")


def _empty_period_card(
    period_number: int,
    space_type: str,
    capacity: int | None,
) -> dict[str, Any]:
    status = "VACANT" if space_type in {"ROOM", "LAB"} else "NOT_APPLICABLE"
    return {
        "period_number": period_number,
        "time_label": period_time_label(period_number),
        "class_code": None,
        "department": None,
        "year": None,
        "section": None,
        "student_strength": None,
        "room_capacity": capacity,
        "subject_title": None,
        "session_type": None,
        "faculty_name": None,
        "location_status": status,
        "is_relocated": False,
        "relocated_from_code": None,
        "relocated_to_code": None,
        "away_in_lab_code": None,
    }


def _populated_period_card(
    slot: TimetableSlot,
    student_class: StudentClass,
    capacity: int | None,
    faculty_names: dict[str, str],
    *,
    away_from_home: bool,
) -> dict[str, Any]:
    is_away_in_lab = away_from_home and slot.session_type == "LAB"
    is_relocated = bool(slot.is_relocated)
    location_status = "OCCUPIED"
    if is_away_in_lab:
        location_status = "AWAY_IN_LAB"
    elif is_relocated:
        location_status = "RELOCATED"
    return {
        "period_number": slot.period_number,
        "time_label": period_time_label(slot.period_number),
        "class_code": slot.class_code,
        "department": student_class.department.code,
        "year": student_class.year_number,
        "section": student_class.section_letter,
        "student_strength": student_class.student_strength,
        "room_capacity": capacity,
        "subject_title": slot.subject_title,
        "session_type": slot.session_type,
        "faculty_name": faculty_names.get(slot.faculty_staff_code, slot.faculty_staff_code),
        "location_status": location_status,
        "is_relocated": is_relocated,
        "relocated_from_code": (
            slot.relocated_from_code
            or (student_class.home_room_code if is_relocated else None)
        ),
        "relocated_to_code": slot.effective_space_code if is_relocated else None,
        "away_in_lab_code": slot.effective_space_code if is_away_in_lab else None,
    }


def _complaint_dict(complaint: Complaint) -> dict[str, Any]:
    extracted = _loads(complaint.ai_extracted_json, {})
    public_complaint = _model_dict(complaint)
    public_complaint.pop("vault_token", None)
    public_complaint.pop("reporter_user_id", None)
    comments = []
    for comment in sorted(complaint.comments, key=lambda item: item.created_at):
        public_comment = _model_dict(comment)
        public_comment.pop("vault_token", None)
        public_comment.pop("author_user_id", None)
        comments.append(public_comment)
    return {
        **public_complaint,
        "photo_url": complaint.image_url,
        "target_assets": extracted.get("target_assets", extracted.get("asset_codes", [])),
        "comments": comments,
    }


def _incident_dict(incident: Incident | None) -> dict[str, Any] | None:
    if incident is None:
        return None
    return {
        **_model_dict(incident),
        "root_cause": incident.root_cause_key,
        "affected_space_codes": [
            code.strip() for code in incident.affected_rooms_csv.split(",") if code.strip()
        ],
        "affected_class_codes": [
            code.strip() for code in incident.affected_classes_csv.split(",") if code.strip()
        ],
    }


def _work_order_dict(
    work_order: WorkOrder | None,
    staff_names: dict[str, str],
) -> dict[str, Any] | None:
    if work_order is None:
        return None
    priority = "MEDIUM"
    if work_order.complaint is not None and work_order.complaint.urgency:
        priority = work_order.complaint.urgency
    elif work_order.priority_score >= 90:
        priority = "CRITICAL"
    elif work_order.priority_score >= 70:
        priority = "HIGH"
    elif work_order.priority_score < 30:
        priority = "LOW"
    title = None
    description = None
    if work_order.complaint is not None:
        title = work_order.complaint.title
        description = work_order.complaint.description
    elif work_order.incident is not None:
        title = work_order.incident.title
        description = work_order.incident.ai_summary_text
    return {
        **_model_dict(work_order),
        "work_order_number": work_order.wo_number,
        "title": title,
        "description": description,
        "priority": priority,
        "assigned_staff_name": staff_names.get(work_order.assigned_staff_code or ""),
        "required_parts": _loads(work_order.assignment_score_breakdown_json, {}).get(
            "required_parts", []
        ),
    }


def _sla_dict(clock: SlaClock | None) -> dict[str, Any] | None:
    if clock is None:
        return None
    remaining = max(0.0, clock.resolution_target_mins - clock.elapsed_active_mins)
    progress = min(
        100.0,
        (clock.elapsed_active_mins / clock.resolution_target_mins * 100.0)
        if clock.resolution_target_mins
        else 100.0,
    )
    deadline = _aware(clock.last_tick_at) + timedelta(minutes=remaining)
    return {
        **_model_dict(clock),
        "work_order_id": clock.target_id if clock.target_type == "WORK_ORDER" else None,
        "priority": clock.urgency,
        "target_minutes": clock.resolution_target_mins,
        "elapsed_active_minutes": clock.elapsed_active_mins,
        "remaining_minutes": remaining,
        "progress_percent": progress,
        "deadline_at": deadline.isoformat(),
    }


@router.get("/api/twin/space/{space_code}")
def inspect_space(space_code: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    space_type, space = _resolve_space(db, space_code)
    canonical_code = space.code
    capacity = getattr(space, "capacity", None)
    clock = get_clock()
    day = str(clock["day_of_week"])
    active_period = clock["active_period"]

    classes_list = db.query(StudentClass).all()
    classes = {item.class_code: item for item in classes_list}
    staff_rows = (
        db.query(StaffProfile, User)
        .join(User, StaffProfile.user_id == User.id)
        .all()
    )
    faculty_names = {profile.staff_code: user.full_name for profile, user in staff_rows}

    home_class: StudentClass | None = None
    if isinstance(space, Room):
        if space.home_class_id is not None:
            home_class = next((item for item in classes_list if item.id == space.home_class_id), None)
        if home_class is None:
            home_class = next(
                (item for item in classes_list if item.home_room_code == canonical_code), None
            )

    day_slots = (
        db.query(TimetableSlot)
        .filter(TimetableSlot.day_of_week == day)
        .order_by(TimetableSlot.period_number, TimetableSlot.class_code)
        .all()
    )
    direct_slots = {
        slot.period_number: slot
        for slot in day_slots
        if slot.effective_space_code == canonical_code
    }
    home_slots = {
        slot.period_number: slot
        for slot in day_slots
        if home_class is not None and slot.class_code == home_class.class_code
    }

    def card_for(period_number: int) -> dict[str, Any]:
        direct = direct_slots.get(period_number)
        if direct is not None and direct.class_code in classes:
            return _populated_period_card(
                direct,
                classes[direct.class_code],
                capacity,
                faculty_names,
                away_from_home=False,
            )
        home_slot = home_slots.get(period_number)
        if (
            home_class is not None
            and home_slot is not None
            and home_slot.effective_space_code != canonical_code
        ):
            return _populated_period_card(
                home_slot,
                home_class,
                capacity,
                faculty_names,
                away_from_home=True,
            )
        return _empty_period_card(period_number, space_type, capacity)

    timeline = [card_for(period) for period in range(1, 7)]

    def contextual_card(period_number: int | None, is_current: bool = False) -> dict[str, Any] | None:
        if period_number is None or period_number not in range(1, 7):
            return None
        card = card_for(period_number)
        if is_current:
            card["minutes_remaining"] = clock["minutes_remaining"]
        return card

    previous_period = active_period - 1 if active_period is not None else None
    next_period = active_period + 1 if active_period is not None else None
    period_cards = {
        "previous_period": contextual_card(previous_period),
        "current_period": contextual_card(active_period, is_current=True),
        "next_period": contextual_card(next_period),
    }

    assets = (
        db.query(Asset)
        .filter(Asset.parent_space_code == canonical_code)
        .order_by(Asset.slot_index, Asset.asset_type, Asset.asset_code)
        .all()
    )
    active_complaints = (
        db.query(Complaint)
        .filter(
            Complaint.space_code == canonical_code,
            Complaint.moderation_status == "APPROVED",
            Complaint.status.notin_(_ACTIVE_COMPLAINT_EXCLUSIONS),
        )
        .order_by(Complaint.created_at.desc())
        .all()
    )

    linked_incident_ids = [
        complaint.linked_incident_id
        for complaint in active_complaints
        if complaint.linked_incident_id is not None
    ]
    incident = None
    if linked_incident_ids:
        incident = (
            db.query(Incident)
            .filter(Incident.id.in_(linked_incident_ids))
            .order_by(Incident.created_at.desc())
            .first()
        )
    if incident is None:
        for candidate in db.query(Incident).order_by(Incident.created_at.desc()).all():
            affected = {code.strip() for code in candidate.affected_rooms_csv.split(",")}
            if canonical_code in affected and candidate.status not in {"RESOLVED", "CLOSED"}:
                incident = candidate
                break

    work_order = (
        db.query(WorkOrder)
        .filter(
            WorkOrder.space_code == canonical_code,
            WorkOrder.status.notin_(_ACTIVE_WORK_ORDER_EXCLUSIONS),
        )
        .order_by(WorkOrder.created_at.desc())
        .first()
    )
    sla_clock = None
    if work_order is not None:
        sla_clock = (
            db.query(SlaClock)
            .filter(
                SlaClock.target_type == "WORK_ORDER",
                SlaClock.target_id == work_order.id,
            )
            .first()
        )
    if work_order is None:
        sla_clock = None

    maintenance = (
        db.query(MaintenanceHistory)
        .filter(MaintenanceHistory.space_code == canonical_code)
        .order_by(MaintenanceHistory.completed_at.desc())
        .all()
    )
    asset_types = {asset.asset_code: asset.asset_type for asset in assets}
    maintenance_history = [
        {
            **_model_dict(record),
            "action": record.action_taken,
            "asset_type": asset_types.get(record.asset_code),
            "technician_name": faculty_names.get(record.technician_code, record.technician_code),
            "notes": record.action_taken,
        }
        for record in maintenance
    ]

    now = datetime.now(timezone.utc)
    active_lock = _active_locks(db).get((space_type, canonical_code))
    result: dict[str, Any] = {
        **_model_dict(space),
        "code": canonical_code,
        "alias_code": space_code.upper() if space_code.strip().upper() != canonical_code else None,
        "space_type": space_type,
        "kind": _space_type_for_kind(space_type),
        "visual_state": space.visual_state,
        "distribution_board_code": (
            space.distribution_board.code
            if isinstance(space, (Room, Lab)) and space.distribution_board is not None
            else None
        ),
        "active_lock": _lock_dict(active_lock, now),
        "period_cards": period_cards,
        "full_day_timeline": timeline,
        "assets": [_model_dict(asset) for asset in assets],
        "active_complaints": [_complaint_dict(item) for item in active_complaints],
        "correlated_incident": _incident_dict(incident),
        "active_work_order": _work_order_dict(work_order, faculty_names),
        "sla_clock": _sla_dict(sla_clock),
        "maintenance_history": maintenance_history,
    }
    if isinstance(space, Room):
        result.update(
            {
                "building_code": space.floor.building.code,
                "block": space.floor.building.code,
                "floor_number": space.floor.floor_number,
                "floor": space.floor.floor_number,
                "home_class_code": home_class.class_code if home_class else None,
                "home_student_count": home_class.student_strength if home_class else None,
            }
        )
    elif isinstance(space, Canteen):
        result.update(
            {
                "active_menu": _loads(space.active_menu_json, []),
                "disabled_menu_items": _loads(space.disabled_menu_items_json, []),
            }
        )
    elif isinstance(space, BillBot):
        result["paper_percent"] = space.paper_roll_pct
    return result
