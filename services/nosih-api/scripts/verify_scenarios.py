"""Verify the replayable scenario lab inside one rolled-back transaction."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import engine  # noqa: E402
from _db import enable_utf8_stdout  # noqa: E402

enable_utf8_stdout()

PASSED: list[str] = []
FAILED: list[str] = []


def check(name: str, condition: bool, detail: object = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"PASS  {name}")
    else:
        FAILED.append(name)
        print(f"FAIL  {name}  {detail}")


def main() -> None:
    with engine.connect() as conn:
        trans = conn.begin()

        def scalar(sql: str, **params):
            return conn.execute(text(sql), params).scalar_one()

        denied = scalar("select public.rpc_run_scenario('WATER_LEAK', 'student@nosih.edu.in')")
        check("students cannot run scenarios", denied.get("error") == "FORBIDDEN", denied)

        leak = scalar("select public.rpc_run_scenario('WATER_LEAK', 'facilities@nosih.edu.in')")
        check("water leak scenario runs", leak.get("success") is True and leak.get("status") == "COMPLETED", leak)
        check("scenario names a classroom", leak.get("space_type") == "ROOM", leak.get("space_type"))
        check("scenario creates a ticket", bool(leak.get("ticket_number")), leak.get("ticket_number"))
        check("scenario creates a work order", bool(leak.get("work_order_number")), leak.get("work_order_number"))
        check("scenario creates an SLA clock", leak.get("sla_clock_id") is not None, leak.get("sla_clock_id"))

        space = leak.get("space_code")
        room_state = scalar("select visual_state from public.rooms where code = :space", space=space)
        check("room is marked faulty", room_state == "FAULTY", room_state)
        damaged = scalar(
            "select count(*) from public.assets where parent_space_code = :space and status <> 'OK'",
            space=space,
        )
        check("assets show damage", damaged > 0, damaged)
        channel = scalar(
            "select source_channel from public.complaints where ticket_number = :ticket",
            ticket=leak.get("ticket_number"),
        )
        check("complaint is attributed to simulation", channel == "SIMULATION", channel)

        repeated = scalar("select public.rpc_run_scenario('WATER_LEAK', 'facilities@nosih.edu.in')")
        check("rerun is idempotent", repeated.get("idempotent") is True and repeated.get("run_id") == leak.get("run_id"), repeated)

        reset = scalar("select public.rpc_reset_scenario(:id, 'facilities@nosih.edu.in')", id=leak.get("run_id"))
        check("scenario resets", reset.get("success") is True and reset.get("status") == "REVERTED", reset)
        restored_state = scalar("select visual_state from public.rooms where code = :space", space=space)
        check("room returns to healthy", restored_state == "HEALTHY", restored_state)
        complaint_status = scalar(
            "select status from public.complaints where ticket_number = :ticket", ticket=leak.get("ticket_number")
        )
        check("scenario complaint is resolved", complaint_status == "RESOLVED", complaint_status)
        wo_status = scalar(
            "select status from public.work_orders where id = :id", id=leak.get("work_order_id")
        )
        check("scenario work order is cancelled", wo_status == "CANCELLED", wo_status)

        mismatched = conn.execute(
            text(
                "select count(*) from jsonb_array_elements(cast(:prior as jsonb)) p "
                "join public.assets a on a.asset_code = p->>'asset_code' "
                "where a.status <> p->>'status'"
            ),
            {"prior": json.dumps(leak.get("prior_assets") or [])},
        ).scalar_one()
        check("asset states are restored exactly", mismatched == 0, mismatched)

        again = scalar("select public.rpc_run_scenario('WATER_LEAK', 'facilities@nosih.edu.in')")
        check("a reset scenario can run again", again.get("success") is True and again.get("run_id") != leak.get("run_id"), again)
        scalar("select public.rpc_reset_scenario(:id, 'facilities@nosih.edu.in')", id=again.get("run_id"))

        power = scalar("select public.rpc_run_scenario('POWER_FAULT_LAB', 'incident@nosih.edu.in')")
        check("power fault scenario runs", power.get("success") is True and power.get("space_type") == "LAB", power)
        lab = power.get("space_code")
        lab_state = scalar("select visual_state from public.labs where code = :space", space=lab)
        check("lab is marked faulty", lab_state == "FAULTY", lab_state)
        severity = conn.execute(
            text("select category, urgency from public.complaints where ticket_number = :ticket"),
            {"ticket": power.get("ticket_number")},
        ).one()
        check("safety override classifies the fault", severity.category == "SAFETY_FIRE" and severity.urgency == "CRITICAL", severity)
        lab_assets = scalar(
            "select count(*) from public.assets where parent_space_code = :space and status = 'FAULTY'",
            space=lab,
        )
        check("lab equipment shows damage", lab_assets > 0, lab_assets)

        power_reset = scalar("select public.rpc_reset_scenario(:id, 'incident@nosih.edu.in')", id=power.get("run_id"))
        check("lab scenario resets", power_reset.get("success") is True, power_reset)
        lab_restored = scalar("select visual_state from public.labs where code = :space", space=lab)
        check("lab returns to healthy", lab_restored == "HEALTHY", lab_restored)

        runs = scalar("select public.rpc_list_scenarios()")
        check("scenario history is listed", isinstance(runs, list) and len(runs) >= 3, len(runs) if isinstance(runs, list) else runs)

        trans.rollback()
        print(f"\n{len(PASSED)} passed, {len(FAILED)} failed")
        if FAILED:
            print(json.dumps(FAILED, indent=2))
            sys.exit(1)


if __name__ == "__main__":
    main()
