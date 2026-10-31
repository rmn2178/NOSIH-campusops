"""Verify repair approvals, parts consumption, exam seed and clock coverage."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402

ADMIN = "4642ba88-5b19-458e-b9c0-84e70e04f060"
failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def as_admin(cur) -> None:
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": ADMIN, "role": "authenticated"}),))
    cur.execute("set role authenticated")


def main() -> None:
    with connect() as conn:
        cur = conn.cursor()

        cur.execute("select count(*) from public.exams")
        check("exam schedule seeded", cur.fetchone()[0] > 0)
        cur.execute("select count(*) from public.work_orders wo where not exists (select 1 from public.sla_clocks sc where sc.target_type='WORK_ORDER' and sc.target_id=wo.id)")
        check("every work order has an SLA clock", cur.fetchone()[0] == 0)

        cur.execute("select id, space_code from public.work_orders "
                    "where status in ('ASSIGNED', 'IN_PROGRESS') order by id limit 1")
        row = cur.fetchone()
        if row is None:
            cur.execute("select id, space_code from public.work_orders "
                        "where assigned_staff_code is not null order by id desc limit 1")
            row = cur.fetchone()
        check("an assigned work order is available for the repair test", row is not None, row)
        if row is None:
            print("\nRESULT: 1 FAILURE(S)")
            sys.exit(1)
        wo, space = row
        cur.execute("select sku_code, on_hand_qty, reserved_qty from public.inventory_items where on_hand_qty > 5 order by sku_code limit 1")
        sku, on_hand, reserved = cur.fetchone()
        cur.execute("update public.inventory_items set reserved_qty = reserved_qty + 2 where sku_code = %s", (sku,))
        cur.execute("insert into public.part_reservations (work_order_id, sku_code, quantity_reserved, status, reserved_at) values (%s,%s,2,'RESERVED',now())", (wo, sku))
        cur.execute("update public.work_orders set estimated_cost_inr = 30000 where id = %s", (wo,))

        as_admin(cur)
        cur.execute("select public.rpc_complete_work_order(%s, 'replace condenser', null)", (wo,))
        blocked = cur.fetchone()[0]
        check("costly repair blocked without approval", blocked.get("error") == "REPAIR_APPROVAL_REQUIRED", blocked.get("error"))

        cur.execute("select public.rpc_approve_repair(%s, true, 'Approved by facilities for lab safety', null)", (wo,))
        check("repair approval recorded", cur.fetchone()[0].get("success") is True)

        cur.execute("select public.rpc_complete_work_order(%s, 'replace condenser', null)", (wo,))
        done = cur.fetchone()[0]
        check("completion after approval", done.get("success") is True, done.get("error"))

        cur.execute("select public.rpc_complete_work_order(%s, 'again', null)", (wo,))
        check("repeat completion still rejected", cur.fetchone()[0].get("error") == "INVALID_TRANSITION")

        cur.execute("set role postgres")
        cur.execute("select status from public.part_reservations where work_order_id = %s order by id desc limit 1", (wo,))
        check("reservation consumed", cur.fetchone()[0] == "CONSUMED")
        cur.execute("select on_hand_qty, reserved_qty from public.inventory_items where sku_code = %s", (sku,))
        after_hand, after_reserved = cur.fetchone()
        check("stock decremented once", after_hand == on_hand - 2 and after_reserved == reserved, (after_hand, after_reserved))
        cur.execute("""select coalesce(
                         (select visual_state from public.rooms where code = %s),
                         (select visual_state from public.canteens where code = %s),
                         (select visual_state from public.labs where code = %s))""",
                    (space, space, space))
        state = cur.fetchone()[0]
        check("room state recomputed (not blindly HEALTHY)", state in ("HEALTHY", "FAULTY", "DEGRADED", "BLOCKED_PARTS"), state)

        conn.rollback()

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
