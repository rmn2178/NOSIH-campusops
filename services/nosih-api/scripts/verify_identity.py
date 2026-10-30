"""Assert that privileged RPCs cannot be driven with a forged actor email.

Runs as a real student session, then as a real facilities administrator.
Every mutation attempted here must be rejected (and audited as REJECTED).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402

STUDENT_UUID = "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"   # aids1a01@nosih.edu.in
ADMIN_UUID = "4642ba88-5b19-458e-b9c0-84e70e04f060"     # facilities@nosih.edu.in
FORGED_EMAIL = "facilities@nosih.edu.in"

failures: list[str] = []


def check(label: str, condition: bool, detail: object = "") -> None:
    print(("PASS  " if condition else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not condition:
        failures.append(label)


def as_user(cur, uuid: str) -> None:
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": uuid, "role": "authenticated"}),))
    cur.execute("set role authenticated")


def main() -> None:
    with connect() as conn:
        with conn.cursor() as cur:
            as_user(cur, STUDENT_UUID)

            cur.execute("select public.nosih_actor_role(%s), public.nosih_actor_email()", (FORGED_EMAIL,))
            role, email = cur.fetchone()
            check("student session keeps its own role", role == "STUDENT", role)
            check("student session resolves its own email", email == "aids1a01@nosih.edu.in", email)

            cur.execute("set role postgres")
            cur.execute("select id from public.purchase_requests where status = 'PENDING_APPROVAL' order by id limit 1")
            pr = cur.fetchone()[0]
            cur.execute("select id from public.work_orders where status = 'PENDING_ASSIGNMENT' order by id limit 1")
            wo = cur.fetchone()[0]
            cur.execute("select staff_code from public.staff_profiles where staff_category = 'MAINTENANCE_TECH' order by staff_code limit 1")
            staff = cur.fetchone()[0]

            as_user(cur, STUDENT_UUID)
            cur.execute(
                "select public.rpc_decide_purchase_request(%s, 'APPROVE', null, %s, 'FACILITIES_ADMIN', false, null, null)",
                (pr, FORGED_EMAIL),
            )
            result = cur.fetchone()[0]
            check("student cannot approve with forged email",
                  result.get("success") is False and result.get("error") == "FORBIDDEN", result)

            cur.execute(
                "select public.rpc_assign_or_rebalance_staff(%s, %s, %s, 'FACILITIES_ADMIN', false, null)",
                (wo, staff, FORGED_EMAIL),
            )
            result = cur.fetchone()[0]
            check("student cannot assign staff with forged email",
                  result.get("success") is False and result.get("error") == "FORBIDDEN", result)

            cur.execute("select public.rpc_complete_work_order(%s, 'forged completion attempt', %s)", (wo, FORGED_EMAIL))
            result = cur.fetchone()[0]
            check("student cannot complete a work order with forged email",
                  result.get("success") is False and result.get("error") == "FORBIDDEN", result)

            cur.execute("select public.rpc_execute_room_relocation('C4-03', 'C4-04', 'MON', 3, %s, 'FACILITIES_ADMIN')",
                        (FORGED_EMAIL,))
            result = cur.fetchone()[0]
            check("student cannot relocate a class with forged email",
                  result.get("success") is False and result.get("error") == "FORBIDDEN", result)

            as_user(cur, ADMIN_UUID)
            cur.execute("select public.nosih_actor_role('irrelevant@example.com'), public.nosih_actor_email()")
            role, email = cur.fetchone()
            check("admin session keeps its own role", role == "FACILITIES_ADMIN", role)
            check("admin session resolves its own email", email == FORGED_EMAIL, email)

            cur.execute("select public.rpc_purchase_preflight(%s, 'FACILITIES_ADMIN')", (pr,))
            preflight = cur.fetchone()[0]
            check("admin preflight still works", isinstance(preflight, dict) and "error" not in preflight,
                  list(preflight)[:4])

        conn.rollback()

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
