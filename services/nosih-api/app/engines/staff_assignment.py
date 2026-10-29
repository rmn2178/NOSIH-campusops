import asyncio
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.audit_chain import append_audit_log
from app.engines.resource_lock import lock_details, require_active_lock
from app.models import (
    NotificationLog,
    ResourceLock,
    SlaClock,
    StaffProfile,
    User,
    WorkOrder,
)
from app.ws_manager import ws_hub


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _block_for_space(space_code: str) -> str:
    if space_code.startswith("LAB-"):
        return "LAB_WING"
    return space_code.split("-", 1)[0]


def _block_distance(staff_block: str | None, work_order_block: str) -> int:
    if not staff_block:
        return 2
    if staff_block == work_order_block:
        return 0
    ordered = {"A": 0, "B": 1, "C": 2, "LAB_WING": 3}
    if staff_block in ordered and work_order_block in ordered:
        return abs(ordered[staff_block] - ordered[work_order_block])
    return 2


def _urgency_factor(db: Session, work_order: WorkOrder) -> float:
    clock = db.scalars(
        select(SlaClock).where(SlaClock.target_type == "WORK_ORDER", SlaClock.target_id == work_order.id)
    ).first()
    if clock:
        return {"LOW": 1.0, "MEDIUM": 2.0, "HIGH": 4.0, "CRITICAL": 5.0}.get(clock.urgency, 2.0)
    if work_order.priority_score >= 90:
        return 5.0
    if work_order.priority_score >= 70:
        return 4.0
    if work_order.priority_score >= 40:
        return 2.0
    return 1.0


def _score_profile(
    profile: StaffProfile,
    work_order: WorkOrder,
    sla_urgency_factor: float,
) -> tuple[float, dict[str, Any]]:
    priority_fit = round(max(0.0, min(5.0, work_order.priority_score / 20.0)), 3)
    block_distance = _block_distance(profile.current_block_location, _block_for_space(work_order.space_code))
    terms = {
        "skill": round(2.0 * profile.skill_proficiency, 4),
        "priority_fit": round(3.0 * priority_fit, 4),
        "active_jobs": round(-1.5 * profile.current_active_jobs, 4),
        "block_distance": round(-0.8 * block_distance, 4),
        "hourly_cost": round(-1.0 * profile.hourly_cost_inr / 200.0, 4),
        "sla_urgency": round(1.5 * sla_urgency_factor, 4),
    }
    score = round(sum(terms.values()), 4)
    return score, {
        "inputs": {
            "skill_proficiency": profile.skill_proficiency,
            "priority_fit": priority_fit,
            "current_active_jobs": profile.current_active_jobs,
            "block_distance": block_distance,
            "hourly_cost_inr": profile.hourly_cost_inr,
            "sla_urgency_factor": sla_urgency_factor,
        },
        "terms": terms,
        "formula": "2*skill + 3*priority_fit - 1.5*active_jobs - 0.8*block_distance - hourly_cost/200 + 1.5*sla_urgency",
        "score": score,
    }


def rank_staff_for_work_order(
    db: Session,
    work_order_id: int,
    current_user: User | None = None,
) -> dict[str, Any]:
    work_order = db.get(WorkOrder, work_order_id)
    if work_order is None:
        raise HTTPException(status_code=404, detail=f"Work order {work_order_id} does not exist")

    profiles = db.scalars(
        select(StaffProfile)
        .join(User, StaffProfile.user_id == User.id)
        .where(StaffProfile.staff_category == "MAINTENANCE_TECH")
        .order_by(StaffProfile.staff_code)
    ).all()
    staff_codes = [profile.staff_code for profile in profiles]
    current_time = _now()
    locks = db.scalars(
        select(ResourceLock).where(
            ResourceLock.resource_type == "STAFF",
            ResourceLock.resource_id.in_(staff_codes or [""]),
            ResourceLock.expires_at > current_time,
        )
    ).all()
    locks_by_staff = {lock.resource_id: lock for lock in locks}
    urgency_factor = _urgency_factor(db, work_order)
    available: list[dict[str, Any]] = []
    unavailable: list[dict[str, Any]] = []

    for profile in profiles:
        failed_gate: str | None = None
        reason: str | None = None
        if profile.primary_skill != work_order.required_skill:
            failed_gate = "GATE_1_SKILL_MISMATCH"
            reason = f"PRIMARY_SKILL_MISMATCH (Required {work_order.required_skill}, actual {profile.primary_skill})"
        elif work_order.required_risk_clearance != "STANDARD" and profile.risk_clearance != work_order.required_risk_clearance:
            failed_gate = "GATE_2_RISK_CLEARANCE"
            reason = f"RISK_CLEARANCE_INSUFFICIENT (Required {work_order.required_risk_clearance}, actual {profile.risk_clearance})"
        elif not profile.is_on_shift:
            failed_gate = "GATE_3_OFF_SHIFT"
            reason = "OFF_SHIFT"
        elif profile.is_on_leave:
            failed_gate = "GATE_3_ON_LEAVE"
            reason = "ON_LEAVE"
        elif not profile.user.is_active:
            failed_gate = "GATE_3_INACTIVE_USER"
            reason = "USER_INACTIVE"
        elif profile.current_active_jobs >= profile.max_concurrent_jobs:
            failed_gate = "GATE_4_CAPACITY"
            reason = f"MAX_CONCURRENT_JOBS_REACHED ({profile.current_active_jobs}/{profile.max_concurrent_jobs})"
        elif profile.staff_code in locks_by_staff and (
            current_user is None or locks_by_staff[profile.staff_code].holder_user_id != current_user.id
        ):
            failed_gate = "GATE_5_RESOURCE_LOCKED"
            detail = lock_details(locks_by_staff[profile.staff_code], now=current_time)
            reason = f"LOCKED_BY_USER (Locked by {detail['locked_by_name']} {detail['acquired_seconds_ago']}s ago)"

        base = {
            "staff_code": profile.staff_code,
            "user_id": profile.user_id,
            "full_name": profile.user.full_name,
            "primary_skill": profile.primary_skill,
            "risk_clearance": profile.risk_clearance,
            "current_active_jobs": profile.current_active_jobs,
            "max_concurrent_jobs": profile.max_concurrent_jobs,
        }
        if failed_gate:
            base.update({"failed_gate": failed_gate, "reason": reason, "exclusion_reason": reason})
            unavailable.append(base)
            continue
        score, breakdown = _score_profile(profile, work_order, urgency_factor)
        base.update(
            {
                "score": score,
                "score_breakdown": breakdown,
                "math_breakdown": breakdown,
                "explanation": f"{profile.staff_code} (Score {score:.4f}): all 5 hard gates passed; see math breakdown",
            }
        )
        available.append(base)

    available.sort(key=lambda item: (-item["score"], item["staff_code"]))
    return {
        "work_order_id": work_order.id,
        "wo_number": work_order.wo_number,
        "required_skill": work_order.required_skill,
        "required_risk_clearance": work_order.required_risk_clearance,
        "available_ranked": available,
        "unavailable_staff": unavailable,
    }


def assign_staff_to_work_order(
    db: Session,
    work_order_id: int,
    user: User,
    staff_code: str | None = None,
    lock_id: str | int | None = None,
) -> dict[str, Any]:
    work_order = db.get(WorkOrder, work_order_id)
    if work_order is None:
        raise HTTPException(status_code=404, detail=f"Work order {work_order_id} does not exist")
    ranking = rank_staff_for_work_order(db, work_order_id, current_user=user)
    candidates = ranking["available_ranked"]
    if staff_code:
        candidates = [candidate for candidate in candidates if candidate["staff_code"] == staff_code]
    if not candidates:
        raise HTTPException(
            status_code=409,
            detail={"rule_fired": "NO_ELIGIBLE_STAFF", "unavailable_staff": ranking["unavailable_staff"]},
        )
    selected = candidates[0]
    selected_code = selected["staff_code"]
    require_active_lock(db, user, "STAFF", selected_code, lock_id=lock_id)
    profile = db.scalars(select(StaffProfile).where(StaffProfile.staff_code == selected_code).with_for_update()).first()
    if profile is None:
        raise HTTPException(status_code=404, detail=f"Staff {selected_code} does not exist")

    previous_code = work_order.assigned_staff_code
    if previous_code and previous_code != selected_code:
        previous = db.scalars(select(StaffProfile).where(StaffProfile.staff_code == previous_code).with_for_update()).first()
        if previous:
            previous.current_active_jobs = max(0, previous.current_active_jobs - 1)
    if previous_code != selected_code:
        profile.current_active_jobs += 1
    work_order.assigned_staff_code = selected_code
    work_order.status = "ASSIGNED"
    work_order.assignment_score_breakdown_json = json.dumps(selected["score_breakdown"], sort_keys=True)
    append_audit_log(
        db,
        actor=user,
        action="ASSIGN_STAFF",
        resource_type="WORK_ORDER",
        resource_id=work_order.wo_number,
        outcome="ALLOWED",
        rule_fired="TOP_ELIGIBLE_STAFF_WITH_ACTIVE_LOCK",
        reason=f"Assigned {selected_code}",
        context={"staff_code": selected_code, "score": selected["score"], "score_breakdown": selected["score_breakdown"]},
    )
    db.add(
        NotificationLog(
            channel="EMAIL",
            recipient=profile.user.email,
            subject=f"Assigned to {work_order.wo_number}",
            payload_json=json.dumps({"work_order_id": work_order.id, "staff_code": selected_code, "score": selected["score"]}),
        )
    )
    db.flush()
    return {
        "assigned": True,
        "work_order_id": work_order.id,
        "wo_number": work_order.wo_number,
        "assigned_staff_code": selected_code,
        "score": selected["score"],
        "score_breakdown": selected["score_breakdown"],
    }


def _broadcast_reassignment(payload: dict[str, Any]) -> None:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(ws_hub.broadcast_all("WORK_ORDER_AUTO_REASSIGNED", payload))
    else:
        loop.create_task(ws_hub.broadcast_all("WORK_ORDER_AUTO_REASSIGNED", payload))


def rebalance_on_constraint_change(
    db: Session,
    staff_code: str,
    trigger_reason: str,
) -> dict[str, Any]:
    if trigger_reason not in {"SHIFT_ENDED", "MARKED_LEAVE", "PREEMPTED_BY_CRITICAL"}:
        raise HTTPException(status_code=422, detail="Unsupported reassignment trigger")
    work_orders = db.scalars(
        select(WorkOrder)
        .where(WorkOrder.assigned_staff_code == staff_code, WorkOrder.status.in_(("ASSIGNED", "IN_PROGRESS")))
        .with_for_update()
        .order_by(WorkOrder.priority_score.desc(), WorkOrder.id)
    ).all()
    old_profile = db.scalars(select(StaffProfile).where(StaffProfile.staff_code == staff_code).with_for_update()).first()
    reassigned: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []

    for work_order in work_orders:
        ranking = rank_staff_for_work_order(db, work_order.id)
        candidates = [candidate for candidate in ranking["available_ranked"] if candidate["staff_code"] != staff_code]
        if not candidates:
            unresolved.append({"work_order_id": work_order.id, "wo_number": work_order.wo_number, "reason": "NO_ELIGIBLE_STAFF"})
            continue
        selected = candidates[0]
        new_profile = db.scalars(
            select(StaffProfile).where(StaffProfile.staff_code == selected["staff_code"]).with_for_update()
        ).first()
        if new_profile is None:
            continue
        new_profile.current_active_jobs += 1
        if old_profile:
            old_profile.current_active_jobs = max(0, old_profile.current_active_jobs - 1)
        work_order.assigned_staff_code = selected["staff_code"]
        work_order.reassignment_count += 1
        work_order.last_reassignment_reason = trigger_reason
        work_order.assignment_score_breakdown_json = json.dumps(selected["score_breakdown"], sort_keys=True)
        payload = {
            "work_order_id": work_order.id,
            "wo_number": work_order.wo_number,
            "previous_staff_code": staff_code,
            "new_staff_code": selected["staff_code"],
            "trigger_reason": trigger_reason,
            "score": selected["score"],
        }
        append_audit_log(
            db,
            actor=None,
            action="AUTO_REASSIGNED",
            resource_type="WORK_ORDER",
            resource_id=work_order.wo_number,
            outcome="ALLOWED",
            rule_fired=trigger_reason,
            reason=f"Reassigned from {staff_code} to {selected['staff_code']}",
            context=payload,
        )
        db.add(
            NotificationLog(
                channel="WEBSOCKET",
                recipient="operations",
                subject=f"Auto-reassigned {work_order.wo_number}",
                payload_json=json.dumps(payload, sort_keys=True),
            )
        )
        _broadcast_reassignment(payload)
        reassigned.append(payload)

    db.flush()
    return {
        "staff_code": staff_code,
        "trigger_reason": trigger_reason,
        "reassigned": reassigned,
        "unresolved": unresolved,
        "reassigned_count": len(reassigned),
    }
