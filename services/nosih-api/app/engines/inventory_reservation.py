from datetime import datetime, timezone
from typing import Any, Iterable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.audit_chain import append_audit_log
from app.engines.resource_lock import require_active_lock
from app.models import (
    InventoryItem,
    Lab,
    PartReservation,
    PurchaseRequest,
    Room,
    SlaClock,
    StaffProfile,
    User,
    WorkOrder,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_parts(parts: Iterable[Any]) -> dict[str, int]:
    requested: dict[str, int] = {}
    for part in parts:
        if isinstance(part, dict):
            sku_code = part.get("sku_code")
            quantity = part.get("qty", part.get("quantity"))
        elif isinstance(part, (tuple, list)) and len(part) == 2:
            sku_code, quantity = part
        else:
            sku_code = getattr(part, "sku_code", None)
            quantity = getattr(part, "qty", getattr(part, "quantity", None))
        if not sku_code or not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
            raise HTTPException(status_code=422, detail="Every part must have a sku_code and a positive integer qty")
        sku_code = str(sku_code).strip()
        requested[sku_code] = requested.get(sku_code, 0) + quantity
    if not requested:
        raise HTTPException(status_code=422, detail="At least one part must be requested")
    return dict(sorted(requested.items()))


def _pr_dict(pr: PurchaseRequest) -> dict[str, Any]:
    return {
        "id": pr.id,
        "pr_id": pr.id,
        "pr_number": pr.pr_number,
        "linked_work_order_id": pr.linked_work_order_id,
        "department_code": pr.department_code,
        "sku_code": pr.sku_code,
        "quantity_requested": pr.quantity_requested,
        "unit_cost_inr": pr.unit_cost_inr,
        "total_cost_inr": pr.total_cost_inr,
        "requested_by_user_id": pr.requested_by_user_id,
        "status": pr.status,
        "requires_dual_approval": pr.requires_dual_approval,
        "first_approver_user_id": pr.first_approver_user_id,
        "second_approver_user_id": pr.second_approver_user_id,
        "override_reason": pr.override_reason,
    }


def _next_pr_number(db: Session, year: int) -> str:
    prefix = f"PR-{year}-"
    numbers = db.scalars(select(PurchaseRequest.pr_number).where(PurchaseRequest.pr_number.like(f"{prefix}%"))).all()
    maximum = 0
    for number in numbers:
        try:
            maximum = max(maximum, int(number.rsplit("-", 1)[1]))
        except (IndexError, ValueError):
            continue
    return f"{prefix}{maximum + 1:04d}"


def _requester_for_work_order(db: Session, work_order: WorkOrder, actor: User | None) -> User:
    if actor:
        return actor
    if work_order.complaint and work_order.complaint.reporter:
        return work_order.complaint.reporter
    if work_order.assigned_staff_code:
        profile = db.scalars(select(StaffProfile).where(StaffProfile.staff_code == work_order.assigned_staff_code)).first()
        if profile:
            return profile.user
    fallback = db.scalars(select(User).where(User.is_active.is_(True)).order_by(User.id)).first()
    if fallback is None:
        raise HTTPException(status_code=422, detail="A requester user is required to draft a purchase request")
    return fallback


def _set_space_state(db: Session, space_code: str, state: str) -> None:
    room = db.scalars(select(Room).where(Room.code == space_code).with_for_update()).first()
    if room:
        room.visual_state = state
        return
    lab = db.scalars(select(Lab).where(Lab.code == space_code).with_for_update()).first()
    if lab:
        lab.visual_state = state


def reserve_parts(
    db: Session,
    work_order_id: int,
    parts: Iterable[Any],
    user: User | None = None,
    lock_id: str | int | None = None,
) -> dict[str, Any]:
    """Reserve a complete bill of parts or draft shortage PRs with no writes to reservations."""
    work_order = db.get(WorkOrder, work_order_id)
    if work_order is None:
        raise HTTPException(status_code=404, detail=f"Work order {work_order_id} does not exist")
    requested = _normalize_parts(parts)
    if user:
        require_active_lock(db, user, "WORK_ORDER", str(work_order.id), lock_id=lock_id)

    items: dict[str, InventoryItem] = {}
    for sku_code in sorted(requested):
        item = db.scalars(select(InventoryItem).where(InventoryItem.sku_code == sku_code).with_for_update()).first()
        if item:
            items[sku_code] = item

    shortages: list[dict[str, Any]] = []
    for sku_code, quantity in requested.items():
        item = items.get(sku_code)
        available = item.on_hand_qty - item.reserved_qty if item else 0
        if item is None or available < quantity:
            shortages.append(
                {
                    "sku_code": sku_code,
                    "requested_qty": quantity,
                    "available_qty": max(0, available),
                    "shortage_qty": quantity - max(0, available),
                    "reorder_buffer": item.reorder_threshold if item else 0,
                }
            )

    if shortages:
        # No InventoryItem or PartReservation mutation occurs before this branch.
        work_order.status = "BLOCKED_PARTS"
        _set_space_state(db, work_order.space_code, "BLOCKED_PARTS")
        clock = db.scalars(
            select(SlaClock)
            .where(SlaClock.target_type == "WORK_ORDER", SlaClock.target_id == work_order.id)
            .with_for_update()
        ).first()
        if clock:
            clock.is_paused = True
            clock.pause_reason = f"Awaiting stock for {shortages[0]['sku_code']}"
            clock.last_tick_at = _now()

        requester = _requester_for_work_order(db, work_order, user)
        department_code = requester.department_code or "CSE"
        purchase_requests: list[PurchaseRequest] = []
        for shortage in shortages:
            item = items.get(shortage["sku_code"])
            if item is None:
                continue
            quantity = shortage["shortage_qty"] + item.reorder_threshold
            total_cost = round(quantity * item.unit_cost_inr, 2)
            pr = PurchaseRequest(
                pr_number=_next_pr_number(db, _now().year),
                linked_work_order_id=work_order.id,
                department_code=department_code,
                sku_code=item.sku_code,
                quantity_requested=quantity,
                unit_cost_inr=item.unit_cost_inr,
                total_cost_inr=total_cost,
                requested_by_user_id=requester.id,
                status="PENDING_APPROVAL",
                requires_dual_approval=total_cost > 100000,
            )
            db.add(pr)
            db.flush()
            purchase_requests.append(pr)
        append_audit_log(
            db,
            actor=user,
            action="RESERVE_PARTS",
            resource_type="WORK_ORDER",
            resource_id=work_order.wo_number,
            outcome="ALLOWED",
            rule_fired="STOCK_OUT_AUTO_PURCHASE_REQUEST",
            reason=f"Awaiting stock for {shortages[0]['sku_code']}",
            context={"shortages": shortages, "purchase_requests": [pr.pr_number for pr in purchase_requests]},
        )
        db.flush()
        return {
            "reserved": False,
            "stock_out": True,
            "work_order_id": work_order.id,
            "status": work_order.status,
            "reservations": [],
            "shortages": shortages,
            "purchase_requests": [_pr_dict(pr) for pr in purchase_requests],
            "sla_paused": bool(clock),
        }

    reservations: list[PartReservation] = []
    for sku_code, quantity in requested.items():
        item = items[sku_code]
        item.reserved_qty += quantity
        reservation = PartReservation(work_order_id=work_order.id, sku_code=sku_code, quantity_reserved=quantity)
        db.add(reservation)
        reservations.append(reservation)
    work_order.status = "IN_PROGRESS"
    append_audit_log(
        db,
        actor=user,
        action="RESERVE_PARTS",
        resource_type="WORK_ORDER",
        resource_id=work_order.wo_number,
        outcome="ALLOWED",
        rule_fired="ALL_REQUESTED_PARTS_AVAILABLE",
        reason="Atomically reserved complete parts request",
        context={"parts": requested},
    )
    db.flush()
    return {
        "reserved": True,
        "stock_out": False,
        "work_order_id": work_order.id,
        "status": work_order.status,
        "shortages": [],
        "purchase_requests": [],
        "reservations": [
            {
                "id": reservation.id,
                "work_order_id": reservation.work_order_id,
                "sku_code": reservation.sku_code,
                "quantity_reserved": reservation.quantity_reserved,
                "status": reservation.status,
            }
            for reservation in reservations
        ],
        "sla_paused": False,
    }


def receive_stock(
    db: Session,
    pr_id: int,
    quantity_received: int | None = None,
    user: User | None = None,
) -> dict[str, Any]:
    pr = db.get(PurchaseRequest, pr_id)
    if pr is None:
        raise HTTPException(status_code=404, detail=f"Purchase request {pr_id} does not exist")
    if pr.status not in {"APPROVED", "PARTIALLY_RECEIVED"}:
        raise HTTPException(status_code=409, detail=f"Purchase request must be APPROVED before receiving stock (current: {pr.status})")
    quantity = pr.quantity_requested if quantity_received is None else quantity_received
    if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
        raise HTTPException(status_code=422, detail="quantity_received must be a positive integer")

    item = db.scalars(select(InventoryItem).where(InventoryItem.sku_code == pr.sku_code).with_for_update()).first()
    if item is None:
        raise HTTPException(status_code=404, detail=f"Inventory SKU {pr.sku_code} does not exist")
    item.on_hand_qty += quantity
    pr.status = "STOCK_RECEIVED" if quantity >= pr.quantity_requested else "PARTIALLY_RECEIVED"

    waiting = db.execute(
        select(WorkOrder, PurchaseRequest)
        .join(PurchaseRequest, PurchaseRequest.linked_work_order_id == WorkOrder.id)
        .where(WorkOrder.status == "BLOCKED_PARTS", PurchaseRequest.sku_code == pr.sku_code)
        .order_by(WorkOrder.priority_score.desc(), WorkOrder.id, PurchaseRequest.id)
        .with_for_update()
    ).all()
    unblocked: list[dict[str, Any]] = []
    still_blocked: list[dict[str, Any]] = []
    seen_work_orders: set[int] = set()
    for work_order, shortage_pr in waiting:
        if work_order.id in seen_work_orders:
            continue
        seen_work_orders.add(work_order.id)
        available = item.on_hand_qty - item.reserved_qty
        # Auto-PR quantity is shortage + the item's reorder buffer.
        needed = max(1, shortage_pr.quantity_requested - item.reorder_threshold)
        if available < needed:
            still_blocked.append({"work_order_id": work_order.id, "wo_number": work_order.wo_number, "required_qty": needed, "available_qty": max(0, available)})
            continue
        item.reserved_qty += needed
        reservation = PartReservation(work_order_id=work_order.id, sku_code=item.sku_code, quantity_reserved=needed)
        db.add(reservation)
        db.flush()

        other_shortages = db.scalars(
            select(PurchaseRequest).where(
                PurchaseRequest.linked_work_order_id == work_order.id,
                PurchaseRequest.sku_code != item.sku_code,
                PurchaseRequest.status.in_(("PENDING_APPROVAL", "PENDING_SECOND_APPROVAL", "APPROVED", "PARTIALLY_RECEIVED")),
            )
        ).first()
        if other_shortages:
            still_blocked.append({"work_order_id": work_order.id, "wo_number": work_order.wo_number, "reason": "OTHER_SKU_SHORTAGE"})
            continue

        work_order.status = "IN_PROGRESS"
        _set_space_state(db, work_order.space_code, "HEALTHY")
        clock = db.scalars(
            select(SlaClock)
            .where(SlaClock.target_type == "WORK_ORDER", SlaClock.target_id == work_order.id)
            .with_for_update()
        ).first()
        if clock:
            clock.is_paused = False
            clock.pause_reason = None
            clock.last_tick_at = _now()
        unblocked.append(
            {
                "work_order_id": work_order.id,
                "wo_number": work_order.wo_number,
                "sku_code": item.sku_code,
                "quantity_reserved": needed,
                "reservation_id": reservation.id,
                "sla_resumed": bool(clock),
            }
        )

    append_audit_log(
        db,
        actor=user,
        action="RECEIVE_STOCK",
        resource_type="PURCHASE_REQUEST",
        resource_id=pr.pr_number,
        outcome="ALLOWED",
        rule_fired="APPROVED_STOCK_RECEIPT",
        reason=f"Received {quantity} units of {item.sku_code}",
        context={"quantity_received": quantity, "unblocked": unblocked, "still_blocked": still_blocked},
    )
    db.flush()
    return {
        "received": True,
        "purchase_request": _pr_dict(pr),
        "sku_code": item.sku_code,
        "quantity_received": quantity,
        "on_hand_qty": item.on_hand_qty,
        "reserved_qty": item.reserved_qty,
        "unblocked_work_orders": unblocked,
        "still_blocked_work_orders": still_blocked,
    }


reserve_parts_for_work_order = reserve_parts
receive_purchase_request_stock = receive_stock
