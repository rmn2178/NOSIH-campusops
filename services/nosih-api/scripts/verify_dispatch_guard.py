"""Verify dispatch guards: caller-aware locks, RBAC, stale assignment, self-only claims.

Runs as two managers and one technician inside a transaction that is rolled back.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, ok, detail))


def actor(cur, auth_id: str) -> None:
    cur.execute(
        "select set_config('request.jwt.claims', %s, false)",
        (json.dumps({"sub": str(auth_id), "role": "authenticated"}),),
    )


def rank(cur, wo_id: int) -> dict:
    cur.execute("select public.rpc_rank_staff_for_work_order(%s)", (wo_id,))
    return cur.fetchone()[0]


def claim(cur, resource_type: str, resource_id: str, email: str, name: str, role: str) -> dict:
    cur.execute(
        "select public.rpc_claim_resource_lock(%s, %s, %s, %s, %s)",
        (resource_type, resource_id, email, name, role),
    )
    return cur.fetchone()[0]


def assign_checked(cur, wo_id: int, staff: str, email: str, role: str, expected: dict) -> dict:
    cur.execute(
        "select public.rpc_assign_or_rebalance_staff_checked(%s, %s, %s, %s, %s::jsonb)",
        (wo_id, staff, email, role, json.dumps(expected)),
    )
    return cur.fetchone()[0]


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select auth_user_id, email, full_name, role from public.users "
                "where auth_user_id is not null and role = any(%s) "
                "order by case role when 'SYSTEM_ADMIN' then 0 when 'FACILITIES_ADMIN' then 1 else 2 end limit 3",
                (["SYSTEM_ADMIN", "FACILITIES_ADMIN", "MAINTENANCE"],),
            )
            people = {row[3]: row for row in cur.fetchall()}
            if not all(role in people for role in ("SYSTEM_ADMIN", "FACILITIES_ADMIN", "MAINTENANCE")):
                raise SystemExit("need system admin, facilities admin and maintenance accounts")
            admin_id, admin_email, admin_name, _ = people["SYSTEM_ADMIN"]
            mgr_id, mgr_email, mgr_name, _ = people["FACILITIES_ADMIN"]
            tech_id, tech_email, tech_name, _ = people["MAINTENANCE"]

            cur.execute("select staff_code from public.staff_profiles sp join public.users u on u.id = sp.user_id where u.auth_user_id = %s limit 1", (tech_id,))
            tech_staff = cur.fetchone()[0]

            cur.execute(
                "select id from public.work_orders where status = 'PENDING_ASSIGNMENT' "
                "and assigned_staff_code is null order by priority_score desc limit 1"
            )
            wo_id = cur.fetchone()[0]

            cur.execute(
                "delete from public.resource_locks where resource_type = 'STAFF' and resource_id in "
                "(select staff_code from public.staff_profiles where staff_category = 'MAINTENANCE_TECH')"
            )

            actor(cur, admin_id)
            base = rank(cur, wo_id)
            available = base.get("available_ranked", [])
            check("manager can rank", len(available) >= 2, f"{len(available)} available")
            if len(available) < 2:
                raise SystemExit("need two candidates")
            first, second = available[0]["staff_code"], available[1]["staff_code"]

            check("lock claim by manager succeeds", claim(cur, "STAFF", first, admin_email, admin_name, "SYSTEM_ADMIN").get("success") is True)

            own = rank(cur, wo_id)
            own_codes = [row["staff_code"] for row in own.get("available_ranked", [])]
            check("caller's own lock does not hide the candidate", first in own_codes, first)

            actor(cur, mgr_id)
            other = rank(cur, wo_id)
            blocked = {row["staff_code"]: row for row in other.get("unavailable_staff", [])}
            check("another manager sees the lock as contention", first in blocked and "LOCKED_BY_ANOTHER_ADMIN" in str(blocked[first].get("reason")), str(blocked.get(first)))

            check("second manager claims a different technician", claim(cur, "STAFF", second, mgr_email, mgr_name, "FACILITIES_ADMIN").get("success") is True)
            cur.execute("select assigned_staff_code, reassignment_count from public.work_orders where id = %s", (wo_id,))
            before = cur.fetchone()
            expected_before = {"assigned_staff_code": before[0], "reassignment_count": before[1]}
            assigned = assign_checked(cur, wo_id, second, mgr_email, "FACILITIES_ADMIN", expected_before)
            check("first assignment with fresh state succeeds", assigned.get("success") is True, str(assigned.get("error")))

            actor(cur, admin_id)
            stale = assign_checked(cur, wo_id, first, admin_email, "SYSTEM_ADMIN", expected_before)
            check("stale assignment is rejected", stale.get("success") is False and stale.get("error") == "STALE_ASSIGNMENT", str(stale))
            check("stale reply reports the current assignee", stale.get("current_assignee") == second, str(stale.get("current_assignee")))

            refreshed = assign_checked(
                cur, wo_id, first, admin_email, "SYSTEM_ADMIN",
                {"assigned_staff_code": second, "reassignment_count": 0},
            )
            check("reassignment with refreshed state succeeds", refreshed.get("success") is True, str(refreshed.get("error")))

            cur.execute("reset role")
            cur.execute(
                "select count(*) from public.resource_locks where resource_type = 'STAFF' and resource_id in (%s, %s)",
                (first, second),
            )
            check("both assignment locks are consumed", cur.fetchone()[0] == 0)
            cur.execute("select assigned_staff_code, reassignment_count from public.work_orders where id = %s", (wo_id,))
            assigned_code, reassignments = cur.fetchone()
            check("work order reflects the final assignee", assigned_code == first and reassignments == 1, f"{assigned_code} / {reassignments}")

            actor(cur, tech_id)
            forbidden = rank(cur, wo_id)
            check("technician cannot rank staff", forbidden.get("error") == "FORBIDDEN", str(forbidden.get("error")))
            blocked_claim = claim(cur, "STAFF", second, tech_email, tech_name, "MAINTENANCE")
            check("technician cannot lock a colleague", blocked_claim.get("success") is False and blocked_claim.get("error") == "FORBIDDEN", str(blocked_claim))
            own_claim = claim(cur, "STAFF", tech_staff, tech_email, tech_name, "MAINTENANCE")
            check("technician can lock their own staff row", own_claim.get("success") is True, str(own_claim.get("error")))

            cur.execute("reset role")
            cur.execute(
                "select count(*) from public.audit_logs where rule_fired = 'STALE_ASSIGNMENT' and resource_id = %s",
                (str(wo_id),),
            )
            check("stale rejection is audited", cur.fetchone()[0] >= 1)

        conn.rollback()

    failed = [entry for entry in CHECKS if not entry[1]]
    for name, ok, detail in CHECKS:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" - {detail}" if detail else ""))
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
