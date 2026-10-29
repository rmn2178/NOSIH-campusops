import json
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.audit_chain import append_audit_log
from app.engines.resource_lock import lock_details, require_active_lock
from app.models import (
    Asset,
    Complaint,
    Lab,
    NotificationLog,
    ResourceLock,
    Room,
    StudentClass,
    TimetableSlot,
    User,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _active_complaint(db: Session, space_type: str, space_code: str) -> Complaint | None:
    return db.scalars(
        select(Complaint)
        .where(
            Complaint.space_type == space_type,
            Complaint.space_code == space_code,
            Complaint.status.not_in(("RESOLVED", "CLOSED")),
        )
        .order_by(Complaint.created_at.desc(), Complaint.id.desc())
        .limit(1)
    ).first()


def _session_dict(slot: TimetableSlot) -> dict[str, Any]:
    return {
        "timetable_slot_id": slot.id,
        "period_number": slot.period_number,
        "class_code": slot.class_code,
        "student_strength": slot.student_class.student_strength,
        "subject_title": slot.subject_title,
        "faculty_staff_code": slot.faculty_staff_code,
    }


def _room_score(candidate: Room, faulted: Room) -> tuple[float, dict[str, Any]]:
    candidate_building = candidate.floor.building.code
    faulted_building = faulted.floor.building.code
    different_building = candidate_building != faulted_building
    floor_distance = abs(candidate.floor.floor_number - faulted.floor.floor_number)
    room_distance = abs(candidate.room_number_on_floor - faulted.room_number_on_floor)
    score = 100 - (20 if different_building else 0) - 6 * floor_distance - 0.5 * room_distance
    return round(score, 1), {
        "different_building": different_building,
        "floor_distance": floor_distance,
        "room_number_distance": room_distance,
        "building_penalty": -20 if different_building else 0,
        "floor_penalty": -6 * floor_distance,
        "room_number_penalty": -0.5 * room_distance,
    }


def _vacancy_explanation(
    db: Session,
    candidate: Room,
    day_of_week: str,
    period_number: int,
) -> str:
    if candidate.home_class_id is not None:
        home_class = db.get(StudentClass, candidate.home_class_id)
        if home_class:
            home_slot = db.scalars(
                select(TimetableSlot).where(
                    TimetableSlot.day_of_week == day_of_week,
                    TimetableSlot.period_number == period_number,
                    TimetableSlot.class_code == home_class.class_code,
                )
            ).first()
            if home_slot and home_slot.effective_space_code != candidate.code:
                return f"vacant during P{period_number} because home class {home_class.class_code} is in {home_slot.effective_space_code}"
    return f"vacant during P{period_number}"


def evaluate_room_conflicts(
    db: Session,
    faulted_space_code: str,
    day_of_week: str,
    from_period: int,
    current_user: User | None = None,
) -> dict[str, Any]:
    """Evaluate every impacted session and rank deterministic safe alternates."""
    faulted_room = db.scalars(select(Room).where(Room.code == faulted_space_code)).first()
    faulted_lab = None if faulted_room else db.scalars(select(Lab).where(Lab.code == faulted_space_code)).first()
    if faulted_room is None and faulted_lab is None:
        raise HTTPException(status_code=404, detail=f"Space {faulted_space_code} does not exist")
    if from_period < 1:
        raise HTTPException(status_code=422, detail="from_period must be positive")

    affected_slots = db.scalars(
        select(TimetableSlot)
        .where(
            TimetableSlot.effective_space_code == faulted_space_code,
            TimetableSlot.day_of_week == day_of_week,
            TimetableSlot.period_number >= from_period,
        )
        .order_by(TimetableSlot.period_number, TimetableSlot.class_code)
    ).all()
    affected_sessions = [_session_dict(slot) for slot in affected_slots]
    sessions_by_period: dict[int, list[dict[str, Any]]] = {}
    for session in affected_sessions:
        sessions_by_period.setdefault(session["period_number"], []).append(session)

    if faulted_lab:
        candidates: list[Room | Lab] = list(
            db.scalars(select(Lab).where(Lab.lab_category == faulted_lab.lab_category).order_by(Lab.code)).all()
        )
        candidate_type = "LAB"
    else:
        candidates = list(db.scalars(select(Room).order_by(Room.code)).all())
        candidate_type = "ROOM"
    candidate_codes = [candidate.code for candidate in candidates]

    relevant_slots = db.scalars(
        select(TimetableSlot).where(
            TimetableSlot.day_of_week == day_of_week,
            TimetableSlot.period_number >= from_period,
            TimetableSlot.effective_space_code.in_(candidate_codes or [""]),
        )
    ).all()
    occupants: dict[tuple[int, str], TimetableSlot] = {
        (slot.period_number, slot.effective_space_code): slot for slot in relevant_slots
    }

    assets = db.scalars(
        select(Asset).where(
            Asset.parent_space_type == candidate_type,
            Asset.parent_space_code.in_(candidate_codes or [""]),
            Asset.asset_type == "SMART_BOARD",
        )
    ).all()
    boards_by_space: dict[str, list[Asset]] = {}
    for asset in assets:
        boards_by_space.setdefault(asset.parent_space_code, []).append(asset)

    current_time = _now()
    locks = db.scalars(
        select(ResourceLock).where(
            ResourceLock.resource_type == candidate_type,
            ResourceLock.resource_id.in_(candidate_codes or [""]),
            ResourceLock.expires_at > current_time,
        )
    ).all()
    locks_by_space = {lock.resource_id: lock for lock in locks}

    periods: list[dict[str, Any]] = []
    for period_number in sorted(sessions_by_period):
        period_sessions = sessions_by_period[period_number]
        required_capacity = max(session["student_strength"] for session in period_sessions)
        ranked: list[dict[str, Any]] = []
        unavailable: list[dict[str, Any]] = []
        for candidate in candidates:
            reason: str | None = None
            occupant = occupants.get((period_number, candidate.code))
            complaint = None
            if candidate.visual_state != "HEALTHY":
                complaint = _active_complaint(db, candidate_type, candidate.code)
                suffix = f" (Active complaint {complaint.ticket_number})" if complaint else ""
                reason = f"ROOM_FAULTY{suffix}"
            elif occupant is not None:
                reason = (
                    f"OCCUPIED_BY_CLASS ({occupant.class_code}, "
                    f"{occupant.student_class.student_strength} students)"
                )
            elif candidate.capacity < required_capacity:
                reason = f"INSUFFICIENT_CAPACITY ({candidate.capacity} < {required_capacity} students)"
            elif not boards_by_space.get(candidate.code) or any(
                board.status != "OK" for board in boards_by_space[candidate.code]
            ):
                reason = "SMART_BOARD_DOWN"
            elif candidate.code in locks_by_space and (
                current_user is None or locks_by_space[candidate.code].holder_user_id != current_user.id
            ):
                detail = lock_details(locks_by_space[candidate.code], now=current_time)
                reason = f"LOCKED_BY_USER (Locked by {detail['locked_by_name']} {detail['acquired_seconds_ago']}s ago)"

            base: dict[str, Any] = {
                "code": candidate.code,
                "name": candidate.code,
                "space_code": candidate.code,
                "space_type": candidate_type,
                "capacity": candidate.capacity,
                "period_number": period_number,
            }
            if reason:
                base["exclusion_reason"] = reason
                base["reason"] = reason
                unavailable.append(base)
                continue

            if isinstance(candidate, Room) and isinstance(faulted_room, Room):
                score, breakdown = _room_score(candidate, faulted_room)
                same_building = candidate.floor.building.code == faulted_room.floor.building.code
                same_floor = candidate.floor.floor_number == faulted_room.floor.floor_number
                location = (
                    f"Same floor {candidate.floor.code}"
                    if same_building and same_floor
                    else f"Building {candidate.floor.building.code}, floor {candidate.floor.floor_number}"
                )
                vacancy = _vacancy_explanation(db, candidate, day_of_week, period_number)
                explanation = (
                    f"{candidate.code} (Score {score:.1f}): {location}, capacity {candidate.capacity} >= "
                    f"{required_capacity} students, Smart Board OK, {vacancy}"
                )
            else:
                score = 100.0
                breakdown = {"lab_category_match": True}
                explanation = (
                    f"{candidate.code} (Score 100.0): Matching {candidate.lab_category} lab, "
                    f"capacity {candidate.capacity} >= {required_capacity} students, Smart Board OK, "
                    f"vacant during P{period_number}"
                )
            base.update(
                {
                    "score": score,
                    "score_breakdown": breakdown,
                    "explanation": explanation,
                }
            )
            ranked.append(base)

        ranked.sort(key=lambda item: (-item["score"], item["space_code"]))
        periods.append(
            {
                "period_number": period_number,
                "affected_sessions": period_sessions,
                "available_alternates": ranked[:3],
                "ranked_alternates": ranked,
                "unavailable_spaces": unavailable,
            }
        )

    available_alternates: list[dict[str, Any]] = []
    if periods:
        combined: dict[str, dict[str, Any]] = {}
        for period in periods:
            for item in period["ranked_alternates"]:
                code = item["space_code"]
                aggregate = combined.get(code)
                if aggregate is None:
                    aggregate = {**item, "score": 0.0, "periods_available": []}
                    combined[code] = aggregate
                aggregate["score"] += item["score"]
                aggregate["periods_available"].append(period["period_number"])
        available_alternates = sorted(
            combined.values(),
            key=lambda item: (-len(item["periods_available"]), -item["score"], item["space_code"]),
        )[:3]
        for item in available_alternates:
            item["score"] = round(item["score"] / len(item["periods_available"]), 2)
            item["explanation"] = (
                f"{item['explanation']}. Eligible for {len(item['periods_available'])} of "
                f"{len(periods)} affected period(s) (P{', P'.join(str(p) for p in item['periods_available'])}); "
                "the backend resolves any remaining period from its own ranked vacancy list."
            )

    result: dict[str, Any] = {
        "faulted_space_code": faulted_space_code,
        "faulted_space_type": candidate_type,
        "day_of_week": day_of_week,
        "from_period": from_period,
        "affected_sessions": affected_sessions,
        "periods": periods,
        "available_alternates": available_alternates,
        "unavailable_spaces": periods[0]["unavailable_spaces"] if periods else [],
    }
    return result


def relocate_room(
    db: Session,
    user: User,
    *,
    faulted_space_code: str,
    target_alternate_code: str,
    day_of_week: str,
    from_period: int,
    reason: str = "",
    lock_id: str | int | None = None,
) -> dict[str, Any]:
    require_active_lock(db, user, "LAB" if faulted_space_code.startswith("LAB-") else "ROOM", target_alternate_code, lock_id=lock_id)
    evaluation = evaluate_room_conflicts(db, faulted_space_code, day_of_week, from_period, current_user=user)
    if not evaluation["affected_sessions"]:
        raise HTTPException(status_code=404, detail="No timetable sessions require relocation")

    assignments: list[dict[str, Any]] = []
    for period in evaluation["periods"]:
        ranked_codes = [item["space_code"] for item in period["ranked_alternates"]]
        if not ranked_codes:
            raise HTTPException(
                status_code=409,
                detail={
                    "rule_fired": "NO_ALTERNATE_FOR_PERIOD",
                    "period_number": period["period_number"],
                },
            )
        destination = target_alternate_code if target_alternate_code in ranked_codes else ranked_codes[0]
        assignments.append(
            {
                "period_number": period["period_number"],
                "space_code": destination,
                "fallback_used": destination != target_alternate_code,
            }
        )
    destination_by_period = {item["period_number"]: item["space_code"] for item in assignments}

    slots = db.scalars(
        select(TimetableSlot)
        .where(
            TimetableSlot.effective_space_code == faulted_space_code,
            TimetableSlot.day_of_week == day_of_week,
            TimetableSlot.period_number >= from_period,
        )
        .with_for_update()
        .order_by(TimetableSlot.period_number, TimetableSlot.class_code)
    ).all()
    class_codes = {slot.class_code for slot in slots}
    recipients: dict[int, User] = {}
    for slot in slots:
        slot.effective_space_code = destination_by_period.get(slot.period_number, target_alternate_code)
        slot.is_relocated = True
        slot.relocated_from_code = faulted_space_code
        slot.relocation_reason = reason or f"Fault in {faulted_space_code}"
        advisor = slot.student_class.advisor
        if advisor:
            recipients[advisor.id] = advisor
    students = db.scalars(select(User).where(User.role == "STUDENT", User.class_code.in_(class_codes))).all()
    for student in students:
        recipients[student.id] = student

    payload = {
        "faulted_space_code": faulted_space_code,
        "target_alternate_code": target_alternate_code,
        "day_of_week": day_of_week,
        "from_period": from_period,
        "reason": reason or f"Fault in {faulted_space_code}",
        "assignments": assignments,
    }
    for recipient in sorted(recipients.values(), key=lambda item: item.id):
        db.add(
            NotificationLog(
                channel="EMAIL",
                recipient=recipient.email,
                subject=f"Class relocated from {faulted_space_code} to {target_alternate_code}",
                payload_json=json.dumps(payload, sort_keys=True),
            )
        )
    append_audit_log(
        db,
        actor=user,
        action="ROOM_RELOCATE",
        resource_type="ROOM",
        resource_id=target_alternate_code,
        outcome="ALLOWED",
        rule_fired="VALID_ALTERNATE_WITH_ACTIVE_LOCK",
        reason=reason or f"Relocated from {faulted_space_code}",
        context={**payload, "relocated_slots": len(slots), "notification_count": len(recipients)},
    )
    db.flush()
    return {
        "relocated": True,
        "faulted_space_code": faulted_space_code,
        "target_alternate_code": target_alternate_code,
        "relocated_slots": len(slots),
        "affected_classes": sorted(class_codes),
        "notification_count": len(recipients),
        "assignments": assignments,
    }


relocate_room_slots = relocate_room
