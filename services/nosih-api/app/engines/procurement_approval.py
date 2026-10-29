from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engines.audit_chain import append_audit_log
from app.models import Department, PurchaseRequest, StaffProfile, User, WorkOrder

APPROVER_ROLES = {"FACILITIES_ADMIN", "PROCUREMENT_APPROVER"}
COST_LIMITS = {"FACILITIES_ADMIN": 10000.0, "PROCUREMENT_APPROVER": 100000.0}


def _pr_payload(pr: PurchaseRequest) -> dict[str, Any]:
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


def _rule_fired(rule: str, user: User) -> str:
    if rule == "ROLE_COST_LIMIT":
        if user.role == "FACILITIES_ADMIN":
            return "COST_LIMIT_EXCEEDED_FACILITIES_ADMIN_10K"
        if user.role == "PROCUREMENT_APPROVER":
            return "COST_LIMIT_EXCEEDED_PROCUREMENT_APPROVER_100K"
        return "COST_LIMIT_ROLE_NOT_ELIGIBLE"
    return {
        "ROLE_ELIGIBLE": "RBAC_ROLE_NOT_PERMITTED",
        "NO_SELF_APPROVAL": "SEPARATION_OF_DUTIES_SELF_APPROVAL",
        "NO_ASSIGNEE_CONFLICT": "SEPARATION_OF_DUTIES_ASSIGNEE_CONFLICT",
        "DEPARTMENT_BUDGET_AVAILABLE": "DEPARTMENT_BUDGET_EXCEEDED",
    }.get(rule, rule)


def evaluate_approval_preflight(db: Session, user: User, pr_id: int) -> dict[str, Any]:
    pr = db.get(PurchaseRequest, pr_id)
    if pr is None:
        raise HTTPException(status_code=404, detail=f"Purchase request {pr_id} does not exist")
    department = db.scalars(select(Department).where(Department.code == pr.department_code)).first()
    linked_work_order = db.get(WorkOrder, pr.linked_work_order_id) if pr.linked_work_order_id else None

    role_eligible = user.is_active and user.role in APPROVER_ROLES
    dual_required = pr.total_cost_inr > 100000
    if not role_eligible:
        cost_passed = False
        cost_reason = "Only FACILITIES_ADMIN and PROCUREMENT_APPROVER have a procurement cost limit"
    elif dual_required:
        cost_passed = True
        cost_reason = "Amount exceeds INR 100,000; distinct FACILITIES_ADMIN and PROCUREMENT_APPROVER approvals are required"
    else:
        limit = COST_LIMITS[user.role]
        cost_passed = pr.total_cost_inr <= limit
        cost_reason = f"{user.role} limit is INR {limit:,.0f}; request is INR {pr.total_cost_inr:,.2f}"

    no_self = user.id != pr.requested_by_user_id
    conflict_reasons: list[str] = []
    if linked_work_order:
        if linked_work_order.complaint and linked_work_order.complaint.reporter_user_id == user.id:
            conflict_reasons.append("User initiated the linked work order")
        if linked_work_order.assigned_staff_code:
            assigned = db.scalars(select(StaffProfile).where(StaffProfile.staff_code == linked_work_order.assigned_staff_code)).first()
            if assigned and assigned.user_id == user.id:
                conflict_reasons.append("User is assigned to the linked work order")
    no_assignee_conflict = not conflict_reasons
    budget_available = bool(
        department and department.budget_spent_inr + pr.total_cost_inr <= department.monthly_maintenance_budget_inr
    )
    remaining_budget = (department.monthly_maintenance_budget_inr - department.budget_spent_inr) if department else 0.0

    checks = [
        {
            "rule": "ROLE_ELIGIBLE",
            "passed": role_eligible,
            "rule_fired": None if role_eligible else _rule_fired("ROLE_ELIGIBLE", user),
            "reason": f"Role {user.role} is eligible" if role_eligible else f"Role {user.role} cannot approve purchases",
        },
        {
            "rule": "ROLE_COST_LIMIT",
            "passed": cost_passed,
            "rule_fired": None if cost_passed else _rule_fired("ROLE_COST_LIMIT", user),
            "reason": cost_reason,
            "requires_dual_approval": dual_required,
        },
        {
            "rule": "NO_SELF_APPROVAL",
            "passed": no_self,
            "rule_fired": None if no_self else _rule_fired("NO_SELF_APPROVAL", user),
            "reason": "Requester and approver are distinct" if no_self else "Requester cannot approve their own purchase request",
        },
        {
            "rule": "NO_ASSIGNEE_CONFLICT",
            "passed": no_assignee_conflict,
            "rule_fired": None if no_assignee_conflict else _rule_fired("NO_ASSIGNEE_CONFLICT", user),
            "reason": "No linked work-order conflict" if no_assignee_conflict else "; ".join(conflict_reasons),
        },
        {
            "rule": "DEPARTMENT_BUDGET_AVAILABLE",
            "passed": budget_available,
            "rule_fired": None if budget_available else _rule_fired("DEPARTMENT_BUDGET_AVAILABLE", user),
            "reason": "Department budget is sufficient" if budget_available else "Department monthly maintenance budget would be exceeded",
            "remaining_budget_inr": remaining_budget,
            "requested_cost_inr": pr.total_cost_inr,
        },
    ]
    failed = [check for check in checks if not check["passed"]]
    return {
        "pr_id": pr.id,
        "pr_number": pr.pr_number,
        "user_id": user.id,
        "user_role": user.role,
        "can_approve": not failed,
        "eligible": not failed,
        "checks": checks,
        "failed_checks": failed,
        "failed_rules": [check["rule"] for check in failed],
        "requires_dual_approval": dual_required,
    }


def _reject(
    db: Session,
    user: User,
    pr: PurchaseRequest,
    preflight: dict[str, Any],
    *,
    action: str = "APPROVE_PURCHASE",
) -> None:
    failed_rules = preflight["failed_rules"]
    # Separation-of-duties violations are the most specific rejection reason
    # when a requester also lacks an approver role (for example, MAINTENANCE).
    first_rule = next(
        (rule for rule in ("NO_SELF_APPROVAL", "NO_ASSIGNEE_CONFLICT") if rule in failed_rules),
        failed_rules[0] if failed_rules else "APPROVAL_RULE_FAILED",
    )
    rule_fired = _rule_fired(first_rule, user)
    detail = {**preflight, "rule_fired": rule_fired}
    append_audit_log(
        db,
        actor=user,
        action=action,
        resource_type="PURCHASE_REQUEST",
        resource_id=pr.pr_number,
        outcome="REJECTED",
        rule_fired=rule_fired,
        reason="; ".join(check["reason"] for check in preflight["failed_checks"]),
        context={"failed_checks": preflight["failed_checks"]},
    )
    raise HTTPException(status_code=403, detail=detail)


def approve_purchase_request(db: Session, user: User, pr_id: int) -> dict[str, Any]:
    pr = db.get(PurchaseRequest, pr_id)
    if pr is None:
        raise HTTPException(status_code=404, detail=f"Purchase request {pr_id} does not exist")
    preflight = evaluate_approval_preflight(db, user, pr_id)
    if not preflight["can_approve"]:
        _reject(db, user, pr, preflight)
    if pr.status in {"APPROVED", "STOCK_RECEIVED"}:
        raise HTTPException(status_code=409, detail=f"Purchase request is already {pr.status}")

    dual_required = pr.total_cost_inr > 100000
    pr.requires_dual_approval = dual_required
    if dual_required and pr.first_approver_user_id is not None:
        first_approver = db.get(User, pr.first_approver_user_id)
        if first_approver and first_approver.id == user.id:
            append_audit_log(
                db, actor=user, action="APPROVE_PURCHASE", resource_type="PURCHASE_REQUEST", resource_id=pr.pr_number,
                outcome="REJECTED", rule_fired="DUAL_APPROVAL_REQUIRES_DISTINCT_USER", reason="Second approver must be a different user",
            )
            raise HTTPException(status_code=403, detail={"rule_fired": "DUAL_APPROVAL_REQUIRES_DISTINCT_USER", "preflight": preflight})
        if first_approver and first_approver.role == user.role:
            append_audit_log(
                db, actor=user, action="APPROVE_PURCHASE", resource_type="PURCHASE_REQUEST", resource_id=pr.pr_number,
                outcome="REJECTED", rule_fired="DUAL_APPROVAL_REQUIRES_BOTH_ROLES", reason="Second approver must hold the other authorizing role",
            )
            raise HTTPException(status_code=403, detail={"rule_fired": "DUAL_APPROVAL_REQUIRES_BOTH_ROLES", "preflight": preflight})
        pr.second_approver_user_id = user.id
        pr.status = "APPROVED"
        rule_fired = "DUAL_APPROVAL_COMPLETED"
    elif dual_required:
        pr.first_approver_user_id = user.id
        pr.status = "PENDING_SECOND_APPROVAL"
        rule_fired = "DUAL_APPROVAL_FIRST_APPROVED"
    else:
        pr.first_approver_user_id = user.id
        pr.status = "APPROVED"
        rule_fired = "ALL_FIVE_APPROVAL_RULES_PASSED"

    if pr.status == "APPROVED":
        department = db.scalars(select(Department).where(Department.code == pr.department_code).with_for_update()).first()
        if department is None:
            raise HTTPException(status_code=422, detail=f"Department {pr.department_code} does not exist")
        department.budget_spent_inr += pr.total_cost_inr
    append_audit_log(
        db,
        actor=user,
        action="APPROVE_PURCHASE",
        resource_type="PURCHASE_REQUEST",
        resource_id=pr.pr_number,
        outcome="ALLOWED",
        rule_fired=rule_fired,
        reason=f"Approved by {user.role}",
        context={"preflight": preflight, "status": pr.status},
    )
    db.flush()
    return {
        "approved": pr.status == "APPROVED",
        "requires_second_approval": pr.status == "PENDING_SECOND_APPROVAL",
        "purchase_request": _pr_payload(pr),
        "preflight": preflight,
    }


def override_purchase_request(
    db: Session,
    user: User,
    pr_id: int,
    override_reason: str,
    counter_sign_user_id: int,
) -> dict[str, Any]:
    pr = db.get(PurchaseRequest, pr_id)
    if pr is None:
        raise HTTPException(status_code=404, detail=f"Purchase request {pr_id} does not exist")
    reason = override_reason.strip()
    if len(reason) < 20:
        raise HTTPException(status_code=422, detail="override_reason must contain at least 20 non-whitespace characters")
    counter_signer = db.get(User, counter_sign_user_id)
    if (
        counter_signer is None
        or not counter_signer.is_active
        or counter_signer.id == user.id
        or counter_signer.role not in {"INCIDENT_MANAGER", "PROCUREMENT_APPROVER"}
        or counter_signer.role == user.role
    ):
        append_audit_log(
            db, actor=user, action="OVERRIDE_PURCHASE", resource_type="PURCHASE_REQUEST", resource_id=pr.pr_number,
            outcome="REJECTED", rule_fired="INVALID_COUNTER_SIGNATORY", reason="Override needs a distinct active INCIDENT_MANAGER or PROCUREMENT_APPROVER counter-signatory",
        )
        raise HTTPException(status_code=403, detail={"rule_fired": "INVALID_COUNTER_SIGNATORY"})

    preflight = evaluate_approval_preflight(db, user, pr_id)
    non_overridable = {"ROLE_ELIGIBLE", "NO_SELF_APPROVAL", "NO_ASSIGNEE_CONFLICT"}
    if any(rule in non_overridable for rule in preflight["failed_rules"]):
        _reject(db, user, pr, preflight, action="OVERRIDE_PURCHASE")
    if any(rule not in {"ROLE_COST_LIMIT", "DEPARTMENT_BUDGET_AVAILABLE"} for rule in preflight["failed_rules"]):
        _reject(db, user, pr, preflight, action="OVERRIDE_PURCHASE")

    pr.first_approver_user_id = user.id
    pr.second_approver_user_id = counter_signer.id
    pr.override_reason = reason
    pr.requires_dual_approval = pr.total_cost_inr > 100000
    pr.status = "APPROVED"
    department = db.scalars(select(Department).where(Department.code == pr.department_code).with_for_update()).first()
    if department is None:
        raise HTTPException(status_code=422, detail=f"Department {pr.department_code} does not exist")
    department.budget_spent_inr += pr.total_cost_inr
    append_audit_log(
        db,
        actor=user,
        action="OVERRIDE_PURCHASE",
        resource_type="PURCHASE_REQUEST",
        resource_id=pr.pr_number,
        outcome="OVERRIDE",
        rule_fired="EMERGENCY_COST_BUDGET_OVERRIDE",
        reason=reason,
        context={"counter_sign_user_id": counter_signer.id, "counter_sign_role": counter_signer.role, "overridden_rules": preflight["failed_rules"]},
    )
    db.flush()
    return {
        "approved": True,
        "overridden": True,
        "purchase_request": _pr_payload(pr),
        "counter_sign_user_id": counter_signer.id,
        "preflight": preflight,
    }


approve_purchase = approve_purchase_request
override_purchase = override_purchase_request
