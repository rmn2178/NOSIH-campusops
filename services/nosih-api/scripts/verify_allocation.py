"""Verify technician allocation: ranking payload, lock gate, assignment, lock consumption.

Runs as the System Administrator and rolls everything back.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, ok, detail))


def main() -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select auth_user_id, email, full_name, role from public.users "
                "where role = 'SYSTEM_ADMIN' and auth_user_id is not null limit 1"
            )
            admin = cur.fetchone()
            if not admin:
                raise SystemExit("no linked SYSTEM_ADMIN account")
            admin_id, email, name, role = admin

            # The officer trigger appoints an owner the moment a work order is
            # created, so this gate creates its own job and releases it back to
            # the queue to exercise the administrator path.
            cur.execute(
                "insert into public.work_orders (wo_number, space_code, priority_score, required_skill, "
                "required_risk_clearance, status, target_asset_codes_json, estimated_cost_inr, "
                "reassignment_count, assignment_score_breakdown_json, created_at) "
                "values ('WO-2026-9101', 'C4-04', 70, 'ELECTRICAL', 'HIGH_VOLTAGE', 'PENDING_ASSIGNMENT', "
                "'[]', 0, 0, '{}'::jsonb, now()) "
                "returning id, wo_number, required_skill, required_risk_clearance"
            )
            wo = cur.fetchone()
            if not wo:
                raise SystemExit("could not create a work order to assign")
            wo_id, wo_number, required_skill, required_risk = wo
            cur.execute(
                "update public.work_orders set assigned_staff_code = null, status = 'PENDING_ASSIGNMENT' "
                "where id = %s",
                (wo_id,),
            )
            print(f"work order: {wo_number} · requires {required_skill}/{required_risk}")

            cur.execute(
                "select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": str(admin_id), "role": "authenticated"}),),
            )
            cur.execute("set role authenticated")

            cur.execute("select public.rpc_rank_staff_for_work_order(%s)", (wo_id,))
            ranking = cur.fetchone()[0]
            available = ranking.get("available_ranked", [])
            check("ranking returns candidates", len(available) > 0, f"{len(available)} available")
            top = available[0] if available else {}
            check("candidate carries risk clearance", "risk_clearance" in top, str(top.get("risk_clearance")))
            check("candidate carries shift state", "is_on_shift" in top, str(top.get("is_on_shift")))
            check("candidate carries workload", "current_active_jobs" in top, f"{top.get('current_active_jobs')}/{top.get('max_concurrent_jobs')}")

            if len(available) < 2:
                raise SystemExit("need two candidates for the lock-gate test")
            first, second = available[0]["staff_code"], available[1]["staff_code"]

            cur.execute(
                "select public.rpc_assign_or_rebalance_staff(%s, %s, %s, %s)",
                (wo_id, second, email, role),
            )
            gate = cur.fetchone()[0]
            check("assignment without a lock is rejected", gate.get("success") is False and gate.get("error") == "LOCK_REQUIRED", str(gate.get("error")))

            cur.execute("reset role")
            cur.execute("select current_active_jobs from public.staff_profiles where staff_code = %s", (first,))
            jobs_before = cur.fetchone()[0]
            cur.execute(
                "delete from public.resource_locks where resource_type = 'STAFF' and resource_id = %s", (first,)
            )
            cur.execute(
                "select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": str(admin_id), "role": "authenticated"}),),
            )
            cur.execute("set role authenticated")

            cur.execute(
                "select public.rpc_claim_resource_lock('STAFF', %s, %s, %s, %s)",
                (first, email, name, role),
            )
            claimed = cur.fetchone()[0]
            check("lock claim succeeds", claimed.get("success") is True, str(claimed.get("error")))

            cur.execute(
                "select public.rpc_assign_or_rebalance_staff(%s, %s, %s, %s)",
                (wo_id, first, email, role),
            )
            assigned = cur.fetchone()[0]
            check("assignment with the lock succeeds", assigned.get("success") is True, str(assigned.get("error")))

            cur.execute("reset role")
            cur.execute(
                "select count(*) from public.resource_locks where resource_type = 'STAFF' and resource_id = %s", (first,)
            )
            check("lock is consumed after assignment", cur.fetchone()[0] == 0, "resource_locks row removed")

            cur.execute(
                "select status, assigned_staff_code from public.work_orders where id = %s", (wo_id,)
            )
            status, staff_code = cur.fetchone()
            check("work order is assigned", status == "ASSIGNED" and staff_code == first, f"{status} · {staff_code}")

            cur.execute("select current_active_jobs from public.staff_profiles where staff_code = %s", (first,))
            jobs_after = cur.fetchone()[0]
            check("technician workload increments", jobs_after == jobs_before + 1, f"{jobs_before} -> {jobs_after}")

        conn.rollback()

    failed = [entry for entry in CHECKS if not entry[1]]
    for name, ok, detail in CHECKS:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" - {detail}" if detail else ""))
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
