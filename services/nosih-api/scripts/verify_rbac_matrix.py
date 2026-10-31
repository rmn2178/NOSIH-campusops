"""Prove the role matrix: sign-in, scoped reads and session-bound RPC guards.

Checks run against the live Supabase REST API with real user tokens, plus one
transactional database probe for purchase-approval separation of duties.
Every check prints PASS/FAIL; the script exits non-zero on any failure.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402
from _db import resilient_connect as connect  # noqa: E402

PASSWORD = "Nosih@2026"
results: list[tuple[str, bool, str]] = []

LOGINS = {
    "SYSTEM_ADMIN": "sysadmin@nosih.edu.in",
    "INCIDENT_MANAGER": "incident@nosih.edu.in",
    "FACILITIES_ADMIN": "facilities@nosih.edu.in",
    "PROCUREMENT_APPROVER": "procurement@nosih.edu.in",
    "DEPARTMENT_MANAGER": "hod.cse@nosih.edu.in",
    "MAINTENANCE": "maint03@nosih.edu.in",
    "FACULTY": "fac001@nosih.edu.in",
    "LAB_STAFF": "labstf001@nosih.edu.in",
}


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, condition, detail))
    print(f"{'PASS' if condition else 'FAIL'}  {name}" + (f"  [{detail}]" if detail and not condition else ""))


def database_url() -> str:
    return settings.database_url.replace("postgresql+psycopg://", "postgresql://")


def rest(path: str, token: str | None = None, payload: dict | None = None) -> tuple[int, object]:
    headers = {
        "apikey": settings.supabase_publishable_key or "",
        "Content-Type": "application/json",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{settings.supabase_url}{path}",
        data=data,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read()
        try:
            parsed = json.loads(body) if body else None
        except ValueError:
            parsed = body.decode("utf-8", "replace")
        return exc.code, parsed


def sign_in(email: str) -> str | None:
    status, body = rest(
        "/auth/v1/token?grant_type=password",
        payload={"email": email, "password": PASSWORD},
    )
    if status != 200 or not isinstance(body, dict):
        return None
    return body.get("access_token")


def rows(token: str | None, table: str, query: str = "select=*") -> list[dict] | None:
    status, body = rest(f"/rest/v1/{table}?{query}", token)
    if status != 200 or not isinstance(body, list):
        return None
    return body


def main() -> None:
    tokens: dict[str, str] = {}
    for role, email in LOGINS.items():
        token = sign_in(email)
        if token:
            tokens[role] = token
        check(f"{role} signs in", token is not None, email)
    if len(tokens) != len(LOGINS):
        summary()
        return

    # Space mappings used as the expectation for scoped reads.
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select department_code, space_code from public.department_spaces")
        mapping: dict[str, set[str]] = {}
        for dept, space in cur.fetchall():
            mapping.setdefault(dept, set()).add(space)
        cur.execute("select id, pr_number from public.purchase_requests order by id limit 1")
        probe_pr_id, probe_pr_number = cur.fetchone()

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select email, id, auth_user_id from public.users "
            "where email in ('facilities@nosih.edu.in','procurement@nosih.edu.in',"
            "'labstf001@nosih.edu.in','hod.cse@nosih.edu.in')"
        )
        actors = {email: (user_id, auth_id) for email, user_id, auth_id in cur.fetchall()}

    cse = tokens["DEPARTMENT_MANAGER"]
    facilities = tokens["FACILITIES_ADMIN"]
    faculty = tokens["FACULTY"]
    labstaff = tokens["LAB_STAFF"]
    maintenance = tokens["MAINTENANCE"]

    # --- Scoped work-order reads ---------------------------------------------
    cse_wos = rows(cse, "work_orders", "select=space_code&limit=1000") or []
    cse_spaces = {row["space_code"] for row in cse_wos}
    check("CSE manager sees CSE work orders", "B3-01" in cse_spaces, ",".join(sorted(cse_spaces)[:8]))
    check("CSE manager cannot see AIDS-only room", "A1-01" not in cse_spaces)
    check("CSE manager space set is within mapping", cse_spaces <= mapping["CSE"])

    aids_token = sign_in("hod.aids@nosih.edu.in")
    check("AIDS manager signs in", aids_token is not None)
    if aids_token:
        aids_spaces = {row["space_code"] for row in (rows(aids_token, "work_orders", "select=space_code&limit=1000") or [])}
        check("AIDS manager sees AIDS-only room", "A1-01" in aids_spaces)
        check("AIDS manager cannot see CSE room", "B3-01" not in aids_spaces)
        check("AIDS manager space set is within mapping", aids_spaces <= mapping["AIDS"])

    facilities_spaces = {row["space_code"] for row in (rows(facilities, "work_orders", "select=space_code&limit=1000") or [])}
    check("Facilities admin sees CSE and AIDS work orders", {"B3-01", "A1-01"} <= facilities_spaces)
    check("Faculty sees no work orders", rows(faculty, "work_orders") == [])
    check("Lab staff sees no work orders", rows(labstaff, "work_orders") == [])

    maint_spaces = {row["space_code"] for row in (rows(maintenance, "work_orders", "select=space_code&limit=1000") or [])}
    check("Technician reads stay inside own department", maint_spaces <= mapping["CSE"])

    # --- SLA clocks follow the same space scope -------------------------------
    cse_clocks = rows(cse, "sla_clocks", "select=space_code&limit=1000") or []
    check("CSE manager sees CSE SLA clocks", len(cse_clocks) > 0)
    check("CSE manager SLA spaces are scoped", {row["space_code"] for row in cse_clocks} <= mapping["CSE"])

    # --- Purchase request scope ----------------------------------------------
    cse_prs = rows(cse, "purchase_requests", "select=department_code&limit=1000") or []
    check("CSE manager sees only CSE purchase requests",
          len(cse_prs) > 0 and {row["department_code"] for row in cse_prs} == {"CSE"})
    aids_prs = rows(aids_token, "purchase_requests", "select=department_code&limit=1000") if aids_token else None
    check("AIDS manager sees only AIDS purchase requests",
          bool(aids_prs) and {row["department_code"] for row in aids_prs} == {"AIDS"})
    facilities_prs = rows(facilities, "purchase_requests", "select=department_code&limit=1000") or []
    check("Facilities admin sees every department",
          len({row["department_code"] for row in facilities_prs}) > 1)
    check("Faculty sees no purchase requests", rows(faculty, "purchase_requests") == [])

    # --- Campus graph reads ---------------------------------------------------
    check("Department manager reads the campus graph", len(rows(cse, "rooms", "select=code&limit=5") or []) > 0)
    check("Department manager reads inventory", len(rows(cse, "inventory_items", "select=sku_code&limit=5") or []) > 0)
    check("Department manager reads incidents", rows(cse, "incidents", "select=id&limit=5") is not None)
    check("Faculty cannot read the campus graph", rows(faculty, "rooms", "select=code&limit=5") == [])
    check("Faculty cannot read inventory", rows(faculty, "inventory_items", "select=sku_code&limit=5") == [])

    # --- Sensitive admin tables stay admin-only ------------------------------
    check("Department manager cannot read audit ledger", rows(cse, "audit_logs", "select=id&limit=5") == [])
    check("Facilities admin reads the audit ledger", len(rows(facilities, "audit_logs", "select=id&limit=5") or []) > 0)
    users_seen = rows(cse, "users", "select=email&limit=50") or []
    check("Department manager sees only own profile", users_seen == [{"email": "hod.cse@nosih.edu.in"}],
          json.dumps(users_seen[:3]))
    check("Anonymous cannot read work orders", rows(None, "work_orders", "select=id&limit=5") == [])

    # --- Session-bound RPC guards --------------------------------------------
    def decide(token: str, pr_id: int, pr_number: str, forged_email: str, forged_role: str) -> dict:
        status, body = rest(
            "/rest/v1/rpc/rpc_decide_purchase_request",
            token,
            {
                "p_pr_id": pr_id,
                "p_decision": "APPROVE",
                "p_actor_user_id": 0,
                "p_actor_email": forged_email,
                "p_actor_role": forged_role,
                "p_is_override": False,
                "p_override_reason": None,
                "p_countersign_email": None,
            },
        )
        return body if isinstance(body, dict) else {"_status": status, "_body": body}

    denied = decide(faculty, probe_pr_id, probe_pr_number, "facilities@nosih.edu.in", "FACILITIES_ADMIN")
    check("Faculty cannot decide purchases with a forged admin email", denied.get("error") == "FORBIDDEN",
          json.dumps(denied))
    check("Lab staff cannot decide purchases", decide(labstaff, probe_pr_id, probe_pr_number,
          "labstf001@nosih.edu.in", "LAB_STAFF").get("error") == "FORBIDDEN")
    cross_department = decide(cse, probe_pr_id, probe_pr_number,
          "hod.cse@nosih.edu.in", "DEPARTMENT_MANAGER")
    check("Department manager cannot approve another department",
          cross_department.get("error") == "FORBIDDEN_DEPARTMENT_SCOPE", json.dumps(cross_department))
    check("Procurement approver passes the role gate", decide(
        tokens["PROCUREMENT_APPROVER"], 999999, "PR-NONE", "procurement@nosih.edu.in",
        "PROCUREMENT_APPROVER").get("error") == "PURCHASE_REQUEST_NOT_FOUND")

    # The FORBIDDEN attempt is audited under the real session actor.
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select actor_email, actor_role, rule_fired from public.audit_logs "
            "where action = 'APPROVE_PURCHASE' and resource_id = %s "
            "and actor_email = 'fac001@nosih.edu.in' "
            "order by id desc limit 1",
            (probe_pr_number,),
        )
        audit = cur.fetchone()
    check("Forged attempt is audited as the session actor",
          bool(audit) and audit[0] == "fac001@nosih.edu.in" and audit[1] == "FACULTY",
          json.dumps(audit))

    # --- Separation of duties in one rolled-back transaction -----------------
    facilities_user_id, facilities_auth_id = actors["facilities@nosih.edu.in"]
    _, procurement_auth_id = actors["procurement@nosih.edu.in"]
    _, cse_manager_auth_id = actors["hod.cse@nosih.edu.in"]
    labstaff_user_id, _ = actors["labstf001@nosih.edu.in"]

    def probe_approval(requester_id: int, actor_email: str, actor_auth_id: str) -> dict:
        with connect() as conn, conn.cursor() as cur:
            cur.execute("begin")
            try:
                cur.execute("select sku_code, unit_cost_inr from public.inventory_items order by sku_code limit 1")
                sku, unit_cost = cur.fetchone()
                cur.execute(
                    "insert into public.purchase_requests (pr_number, department_code, sku_code, "
                    "quantity_requested, unit_cost_inr, total_cost_inr, requested_by_user_id, status, "
                    "requires_dual_approval, created_at) values (%s,'CSE',%s,1,%s,%s,%s,'PENDING_APPROVAL',false,now()) returning id",
                    (f"PR-RBACHECK-{requester_id}", sku, unit_cost, unit_cost, requester_id),
                )
                pr_id = cur.fetchone()[0]
                cur.execute("select set_config('request.jwt.claim.sub', %s, true)", (str(actor_auth_id),))
                cur.execute("select set_config('request.jwt.claims', %s, true)",
                            (json.dumps({"sub": str(actor_auth_id), "role": "authenticated"}),))
                cur.execute("set local role authenticated")
                cur.execute(
                    "select public.rpc_decide_purchase_request(%s,'APPROVE',0,%s,'FACILITIES_ADMIN',false,null,null)",
                    (pr_id, actor_email),
                )
                return cur.fetchone()[0]
            finally:
                conn.rollback()

    self_approval = probe_approval(facilities_user_id, "facilities@nosih.edu.in", facilities_auth_id)
    check("Self-approval is rejected", self_approval.get("rule_fired") ==
          "SEPARATION_OF_DUTIES_SELF_APPROVAL_FORBIDDEN", json.dumps(self_approval))
    distinct_approval = probe_approval(labstaff_user_id, "procurement@nosih.edu.in", procurement_auth_id)
    check("A distinct approver clears the same pre-flight",
          distinct_approval.get("success") is True, json.dumps(distinct_approval))
    manager_approval = probe_approval(labstaff_user_id, "hod.cse@nosih.edu.in", cse_manager_auth_id)
    check("Department manager approves within own department",
          manager_approval.get("success") is True, json.dumps(manager_approval))

    summary()


def summary() -> None:
    passed = sum(1 for _, ok, _ in results if ok)
    failed = [name for name, ok, _ in results if not ok]
    print(f"\n{passed}/{len(results)} checks passed")
    if failed:
        print("failed: " + "; ".join(failed))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
