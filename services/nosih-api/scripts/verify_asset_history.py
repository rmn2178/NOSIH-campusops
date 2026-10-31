"""Verify the asset service record: costs, history, open work order and access.

Every write is rolled back. Run with the project virtualenv:
  .venv/Scripts/python.exe scripts/verify_asset_history.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import resilient_connect as connect  # noqa: E402

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def url() -> str:
    return settings.database_url.replace("postgresql+psycopg://", "postgresql://")


def actor(email: str) -> str:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select auth_user_id from public.users where email = %s", (email,))
        return str(cur.fetchone()[0])


def rpc(auth_id: str, asset_code: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select set_config('request.jwt.claims', %s, true)",
                    (json.dumps({"sub": auth_id, "role": "authenticated"}),))
        cur.execute("set local role authenticated")
        cur.execute("select public.rpc_get_asset_history(%s)", (asset_code,))
        return cur.fetchone()[0]


def main() -> None:
    facilities = actor("facilities@nosih.edu.in")
    faculty = actor("fac001@nosih.edu.in")

    with connect() as conn, conn.cursor() as cur:
        cur.execute("select count(*), count(*) filter (where total_cost_inr > 0), "
                    "round(sum(total_cost_inr), 2) from public.maintenance_history")
        rows, costed, total = cur.fetchone()
        check("every seeded repair carries a cost", rows == costed and total > 0, (rows, costed, total))
        cur.execute("select count(*) from public.maintenance_history "
                    "where total_cost_inr <> parts_cost_inr + labour_cost_inr")
        check("cost components add up on every row", cur.fetchone()[0] == 0)
        cur.execute("select count(*) from public.maintenance_history "
                    "where parts_used_json <> '[]' and jsonb_array_length(parts_used_json::jsonb) = 0")
        parts_bad = cur.fetchone()[0]
        check("parts payload is valid JSON for every row", parts_bad == 0, parts_bad)
        cur.execute("select count(*), max(downtime_mins), max(labour_cost_inr) from public.maintenance_history")
        repair_rows, longest, costliest = cur.fetchone()
        check("billed downtime never exceeds 24 hours", repair_rows > 0 and longest <= 1440,
              (repair_rows, longest))
        cur.execute("""select count(*) from public.maintenance_history mh
                         join public.staff_profiles sp on sp.staff_code = mh.technician_code
                        where mh.downtime_mins > 0
                          and abs(mh.labour_cost_inr
                                  - round((mh.downtime_mins / 60.0 * sp.hourly_cost_inr)::numeric, 2)) > 0.01""")
        skewed = cur.fetchone()[0]
        check("labour matches billed downtime at the technician rate", skewed == 0, skewed)
        cur.execute("select has_function_privilege('anon', "
                    "'public.rpc_get_asset_history(text)', 'EXECUTE')")
        check("anonymous callers cannot execute the asset record", cur.fetchone()[0] is False)

    record = rpc(facilities, "FAN-A1-02-01")
    check("facilities admin opens an asset record", "error" not in record, record.get("error"))
    asset = record.get("asset", {})
    stats = record.get("stats", {})
    history = record.get("history", [])
    check("asset identity resolves", asset.get("asset_code") == "FAN-A1-02-01"
          and asset.get("name") == "Ceiling Fan 1" and asset.get("space_code") == "A1-02", asset.get("name"))
    check("both previous repairs are returned", stats.get("repair_count") == 2 and len(history) == 2,
          (stats.get("repair_count"), len(history)))
    check("lifetime cost includes parts and labour",
          float(stats.get("total_cost_inr", 0)) > 0
          and abs(float(stats.get("total_parts_cost_inr", 0)) + float(stats.get("total_labour_cost_inr", 0))
                  - float(stats.get("total_cost_inr", 0))) < 0.01,
          stats.get("total_cost_inr"))
    check("history total matches lifetime cost",
          abs(sum(float(item["total_cost_inr"]) for item in history) - float(stats["total_cost_inr"])) < 0.01,
          [item["total_cost_inr"] for item in history])
    first = history[0]
    check("repair detail includes time, technician, downtime and cost",
          bool(first.get("completed_at")) and bool(first.get("technician_name"))
          and first.get("downtime_mins", 0) > 0 and float(first.get("total_cost_inr", 0)) > 0,
          first.get("technician_name"))
    check("repair detail includes the consumed part",
          len(first.get("parts", [])) == 1 and first["parts"][0].get("sku_code") == "SKU-FAN-CAP",
          first.get("parts"))
    check("parts summary aggregates spend",
          len(record.get("parts_summary", [])) == 1
          and float(record["parts_summary"][0]["spend_inr"]) == float(stats["total_parts_cost_inr"]),
          record.get("parts_summary"))
    check("health score is bounded and labelled",
          0 < stats.get("health_score", 0) <= 100
          and stats.get("health_label") in ("CRITICAL", "WATCH", "SERVICED", "STABLE"), stats.get("health_label"))

    # Fixtures move with the live queue: pick the primary asset of a currently
    # open work order, and an asset that has never been repaired.
    with connect() as conn, conn.cursor() as cur:
        cur.execute("""select w.wo_number, w.status,
                              jsonb_array_elements_text(w.target_asset_codes_json::jsonb) as asset
                         from public.work_orders w
                        where w.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS')
                          and jsonb_array_length(w.target_asset_codes_json::jsonb) > 0
                        order by w.id limit 1""")
        wo_number, wo_status, open_asset = cur.fetchone()
        cur.execute("""select a.asset_code from public.assets a
                        where not exists (select 1 from public.maintenance_history m
                                           where m.asset_code = a.asset_code)
                          and not exists (select 1 from public.work_orders w
                                           where w.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS')
                                             and w.target_asset_codes_json::text like '%' || a.asset_code || '%')
                        order by a.asset_code limit 1""")
        clean_asset = cur.fetchone()[0]

    open_record = rpc(facilities, open_asset)
    current = open_record.get("current_work_order") or {}
    check("open work order is surfaced on the asset",
          open_record.get("error") is None and current.get("wo_number") == wo_number
          and current.get("status") == wo_status, (open_asset, current))
    empty_record = rpc(facilities, clean_asset)
    check("asset with no repairs returns an explicit empty record",
          empty_record.get("error") is None and empty_record.get("history") == []
          and empty_record.get("stats", {}).get("repair_count") == 0,
          (clean_asset, empty_record.get("stats", {}).get("repair_count")))

    denied = rpc(faculty, "FAN-A1-02-01")
    check("faculty session cannot read the operational asset record", denied.get("error") == "FORBIDDEN", denied)
    missing = rpc(facilities, "NO-SUCH-ASSET")
    check("unknown asset is rejected", missing.get("error") == "ASSET_NOT_FOUND", missing)

    # The insert trigger prices a new repair from the technician and downtime.
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select wo_number, assigned_staff_code, space_code from public.work_orders "
                    "where assigned_staff_code is not null and status not in ('COMPLETED','CLOSED') "
                    "order by id desc limit 1")
        wo_number, staff_code, space_code = cur.fetchone()
        cur.execute("select hourly_cost_inr from public.staff_profiles where staff_code = %s", (staff_code,))
        rate = float(cur.fetchone()[0])
        cur.execute(
            "insert into public.maintenance_history (space_code, asset_code, work_order_number, "
            "fault_category, action_taken, parts_used_json, technician_code, downtime_mins, completed_at) "
            "values (%s, 'TEST-ASSET', %s, 'ELECTRICAL', 'Trigger cost check', '[]', %s, 120, now()) "
            "returning labour_cost_inr, total_cost_inr",
            (space_code, wo_number, staff_code),
        )
        labour, total_cost = cur.fetchone()
        check("new repair rows are priced automatically",
              abs(float(labour) - 2 * rate) < 0.01 and abs(float(total_cost) - float(labour)) < 0.01,
              (staff_code, rate, labour))
        conn.rollback()

    # A ticket raised months ago must not bill months of labour: completion
    # clamps downtime to 24 hours before pricing the repair.
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select w.id, w.wo_number, sp.hourly_cost_inr "
                    "from public.work_orders w "
                    "join public.staff_profiles sp on sp.staff_code = w.assigned_staff_code "
                    "where w.assigned_staff_code is not null "
                    "and w.status in ('ASSIGNED', 'IN_PROGRESS') "
                    "order by w.id limit 1")
        row = cur.fetchone()
        check("an assigned work order is available to backdate", row is not None, row)
        if row:
            wo_id, wo_number, rate = row
            cur.execute("update public.work_orders set created_at = now() - interval '90 days' "
                        "where id = %s", (wo_id,))
            cur.execute("select set_config('request.jwt.claims', %s, true)",
                        (json.dumps({"sub": facilities, "role": "authenticated"}),))
            cur.execute("set local role authenticated")
            cur.execute("select public.rpc_complete_work_order(%s, 'Backdated completion check', null)",
                        (wo_id,))
            done = cur.fetchone()[0]
            check("a 90-day-old ticket still completes", done.get("success") is True, done)
            cur.execute("reset role")
            cur.execute("select max(downtime_mins), max(labour_cost_inr), max(total_cost_inr) "
                        "from public.maintenance_history where work_order_number = %s", (wo_number,))
            longest, labour, total_cost = cur.fetchone()
            check("backdated completion bills at most 24 hours of labour",
                  int(longest) == 1440
                  and abs(float(labour) - 24 * float(rate)) < 0.01
                  and float(total_cost) <= 24 * float(rate) + 5000,
                  (wo_number, longest, labour, rate))
        conn.rollback()

    print(f"\nRESULT: {'ALL PASS' if not failures else f'{len(failures)} FAILURE(S)'}")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
