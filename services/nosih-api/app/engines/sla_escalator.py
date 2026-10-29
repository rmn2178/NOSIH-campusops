import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import NotificationLog, SlaClock

TIER_RECIPIENTS = {
    1: "maintenance@nosih.edu.in",
    2: "incident@nosih.edu.in",
    3: "facilities@nosih.edu.in",
    4: "principal@nosih.edu.in",
}
TIER_NAMES = {
    1: "Maintenance",
    2: "Incident Manager",
    3: "Facilities Admin",
    4: "Principal Office",
}


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _notify(clock: SlaClock, state: str) -> list[dict[str, Any]]:
    recipient = TIER_RECIPIENTS[clock.current_escalation_tier]
    payload = {
        "event": "SLA_BREACHED_100" if state == "BREACHED_100" else "SLA_WARNING_75",
        "target_type": clock.target_type,
        "target_id": clock.target_id,
        "space_code": clock.space_code,
        "urgency": clock.urgency,
        "elapsed_active_mins": round(clock.elapsed_active_mins, 4),
        "resolution_target_mins": clock.resolution_target_mins,
        "breach_state": state,
        "escalation_tier": clock.current_escalation_tier,
        "escalation_owner": TIER_NAMES[clock.current_escalation_tier],
    }
    subject = (
        f"SLA breached for {clock.target_type} {clock.target_id} - Tier {clock.current_escalation_tier}"
        if state == "BREACHED_100"
        else f"SLA 75% warning for {clock.target_type} {clock.target_id}"
    )
    records: list[NotificationLog] = []
    for channel in ("EMAIL", "WEBHOOK"):
        record = NotificationLog(
            channel=channel,
            recipient=recipient,
            subject=subject,
            payload_json=json.dumps(payload, sort_keys=True),
            delivery_status="SENT",
        )
        records.append(record)
    return records


def tick_sla_clock(db: Session, clock: SlaClock, now: datetime | None = None) -> dict[str, Any]:
    """Advance active time and emit notifications only on threshold transitions."""
    current_time = _as_utc(now or datetime.now(timezone.utc))
    last_tick = _as_utc(clock.last_tick_at)
    delta_minutes = max(0.0, (current_time - last_tick).total_seconds() / 60.0)
    if not clock.is_paused:
        clock.elapsed_active_mins += delta_minutes
    clock.last_tick_at = current_time

    previous_state = clock.breach_state
    previous_tier = clock.current_escalation_tier
    target = max(1, clock.resolution_target_mins)
    ratio = clock.elapsed_active_mins / target
    notifications: list[NotificationLog] = []
    if ratio >= 1.0:
        clock.breach_state = "BREACHED_100"
        if previous_state != "BREACHED_100":
            clock.current_escalation_tier = min(4, max(1, clock.current_escalation_tier) + 1)
            notifications = _notify(clock, clock.breach_state)
    elif ratio >= 0.75:
        clock.breach_state = "WARNING_75"
        if previous_state not in {"WARNING_75", "BREACHED_100"}:
            notifications = _notify(clock, clock.breach_state)
    elif not clock.is_paused:
        clock.breach_state = "HEALTHY"

    for notification in notifications:
        db.add(notification)
    db.flush()
    return {
        "clock_id": clock.id,
        "target_type": clock.target_type,
        "target_id": clock.target_id,
        "elapsed_active_mins": round(clock.elapsed_active_mins, 4),
        "resolution_target_mins": clock.resolution_target_mins,
        "target_utilization_pct": round(ratio * 100, 2),
        "is_paused": clock.is_paused,
        "pause_reason": clock.pause_reason,
        "breach_state": clock.breach_state,
        "current_escalation_tier": clock.current_escalation_tier,
        "escalation_owner": TIER_NAMES[clock.current_escalation_tier],
        "previous_breach_state": previous_state,
        "previous_escalation_tier": previous_tier,
        "notifications_sent": len(notifications),
    }


def tick_sla_clocks(db: Session, now: datetime | None = None) -> dict[str, Any]:
    current_time = now or datetime.now(timezone.utc)
    clocks = db.scalars(select(SlaClock).order_by(SlaClock.id).with_for_update()).all()
    results = [tick_sla_clock(db, clock, current_time) for clock in clocks]
    return {
        "ticked": len(results),
        "warning_count": sum(result["breach_state"] == "WARNING_75" for result in results),
        "breached_count": sum(result["breach_state"] == "BREACHED_100" for result in results),
        "notifications_sent": sum(result["notifications_sent"] for result in results),
        "clocks": results,
    }


def tick_sla_clock_by_id(db: Session, clock_id: int, now: datetime | None = None) -> dict[str, Any]:
    from fastapi import HTTPException

    clock = db.get(SlaClock, clock_id)
    if clock is None:
        raise HTTPException(status_code=404, detail=f"SLA clock {clock_id} does not exist")
    return tick_sla_clock(db, clock, now)
