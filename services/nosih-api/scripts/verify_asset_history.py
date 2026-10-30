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
from app.config import settings  # noqa: E402

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def url() -> str:
    return settings.database_url.replace("postgresql+psycopg://", "postgresql://")


def actor(email: str) -> str:
    with psycopg.connect(url()) as conn, conn.cursor() as cur:
        cur.execute("select auth_user_id from public.users where email = %s", (email,))
        return str(cur.fetchone()[0])


def rpc(auth_id: str, asset_code: str) -> dict:
    with psycopg.connect(url()) as conn, conn.cursor() as cur:
        cur.execute("select set_config('request.jwt.claims', %s, true)",
                    (json.dumps({"sub": auth_id, "role": "authenticated"}),))
        cur.execute("set local role authenticated")
        cur.execute("select public.rpc_get_asset_history(%s)", (asset_code,))
        return cur.fetchone()[0]


def main() -> None:
    facilities = actor("facilities@nosih.edu.in")
    faculty = actor("fac001@nosih.edu.in")

    with psycopg.connect(url()) as conn, conn.cursor() as cur:
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

    open_record = rpc(facilities, "SB-C4-03-01")
    current = open_record.get("current_work_order") or {}
    check("open work order is surfaced on the asset",
          open_record.get("error") is None and current.get("wo_number") == "WO-2026-0062"
          and current.get("status") == "ASSIGNED", current)
    check("asset with no repairs returns an explicit empty record",
          open_record.get("history") == [] and open_record.get("stats", {}).get("repair_count") == 0,
          open_record.get("stats", {}).get("repair_count"))

    denied = rpc(faculty, "FAN-A1-02-01")
    check("faculty session cannot read the operational asset record", denied.get("error") == "FORBIDDEN", denied)
    missing = rpc(facilities, "NO-SUCH-ASSET")
    check("unknown asset is rejected", missing.get("error") == "ASSET_NOT_FOUND", missing)

    # The insert trigger prices a new repair from the technician and downtime.
    with psycopg.connect(url()) as conn, conn.cursor() as cur:
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

    print(f"\nRESULT: {'ALL PASS' if not failures else f'{len(failures)} FAILURE(S)'}")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
