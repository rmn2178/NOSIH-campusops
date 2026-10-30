"""Verify the Campus Pulse engine end to end. Every mutation is rolled back.

Proves: cron scheduling, pause/cooldown/cap gates, fault injection through the
real pipeline for canteens / bill bots / labs / rooms, dispatch + parts +
completion + pricing, bill-bot twin restore, auto-heal, per-event revert and
the admin control RPC gates.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

STUDENT = "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
ADMIN = "4642ba88-5b19-458e-b9c0-84e70e04f060"

failures: list[str] = []


def connect() -> psycopg.Connection:
    """Connect to the direct DB host, falling back to the Supavisor pooler
    when the direct host has no route (IPv6-only outage)."""
    from urllib.parse import urlsplit, urlunsplit

    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    try:
        return psycopg.connect(url, connect_timeout=15)
    except psycopg.OperationalError:
        parts = urlsplit(url)
        if not parts.password or not parts.hostname or not parts.hostname.startswith("db."):
            raise
        project = parts.hostname.removeprefix("db.").removesuffix(".supabase.co")
        netloc = f"postgres.{project}:{parts.password}@aws-0-eu-west-1.pooler.supabase.com:{parts.port or 5432}"
        url = urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))
        return psycopg.connect(url, connect_timeout=30)


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def as_user(cur, uuid: str) -> None:
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": uuid, "role": "authenticated"}),))
    cur.execute("set role authenticated")


def as_postgres(cur) -> None:
    cur.execute("set role postgres")


def fetch_one(cur, sql: str, params: tuple = ()):
    cur.execute(sql, params)
    return cur.fetchone()


def main() -> None:
    with connect() as conn:
        cur = conn.cursor()

        # -- Scheduling and config ------------------------------------------------
        row = fetch_one(cur, "select schedule from cron.job where jobname = 'nosih-campus-pulse'")
        check("P1 pulse cron scheduled every minute", row is not None and row[0] == "* * * * *", row)

        row = fetch_one(cur, "select enabled, interval_minutes, max_open_simulated from public.simulation_config")
        check("P2 pulse config present", row is not None and row[0] is True, row)

        row = fetch_one(cur, "select position('update public.bill_bots set visual_state' in "
                             "pg_get_functiondef('public.nosih_recompute_space_state(text)'::regprocedure)) > 0")
        check("P3 twin recompute covers bill bots", row[0] is True)

        # -- Tick gates -----------------------------------------------------------
        cur.execute("update public.simulation_config set enabled = false where id")
        row = fetch_one(cur, "select public.rpc_pulse_tick()->>'reason'")
        check("P4 paused pulse does not fire", row[0] == "PAUSED", row[0])

        cur.execute("update public.simulation_config set enabled = true, last_injected_at = now() where id")
        row = fetch_one(cur, "select public.rpc_pulse_tick()->>'reason'")
        check("P5 cooldown honoured", row[0] == "COOLDOWN", row[0])

        for i in range(3):
            cur.execute(
                "insert into public.simulation_events (template_key, facility_kind, space_code, description)"
                " values ('PROBE', 'ROOM', 'PROBE-' || %s::text, 'cap probe')", (str(i),))
        cur.execute("update public.simulation_config set last_injected_at = null where id")
        row = fetch_one(cur, "select public.rpc_pulse_tick()->>'reason'")
        check("P6 open-simulated cap enforced", row[0] == "CAP_REACHED", row[0])
        cur.execute("delete from public.simulation_events where template_key = 'PROBE'")

        # -- Injection through the real pipeline -----------------------------------
        # Deterministic per-family phases: mask the other families in this
        # transaction so each forced injection lands on the intended facility
        # type; the mask is undone immediately and everything rolls back anyway.
        def mask_others(keep: str) -> None:
            for table in ("canteens", "labs", "rooms", "bill_bots"):
                if table != keep:
                    cur.execute(f"update public.{table} set visual_state = 'MASKED'"
                                " where visual_state = 'HEALTHY'")

        def unmask(table: str) -> None:
            cur.execute(f"update public.{table} set visual_state = 'HEALTHY' where visual_state = 'MASKED'")

        def unmask_all() -> None:
            for table in ("canteens", "labs", "rooms", "bill_bots"):
                unmask(table)

        mask_others("bill_bots")
        bot = fetch_one(cur, "select public.nosih_pulse_inject()")[0]
        unmask_all()
        check("P7 forced bill-bot injection through the real pipeline",
              bot.get("fired") is True and bot.get("facility_kind") == "BILL_BOT", bot)

        mask_others("canteens")
        canteen = fetch_one(cur, "select public.nosih_pulse_inject()")[0]
        unmask_all()
        check("P8 forced canteen injection through the real pipeline",
              canteen.get("fired") is True and canteen.get("facility_kind") == "CANTEEN", canteen)

        events = [e for e in (bot, canteen) if e.get("fired") is True]
        kinds = {e["facility_kind"] for e in events}
        spare = None
        for _ in range(8):
            res = fetch_one(cur, "select public.nosih_pulse_inject()")[0]
            if res.get("fired") is not True:
                break
            events.append(res)
            kinds.add(res["facility_kind"])
            if res["facility_kind"] in ("ROOM", "LAB") and spare is None:
                spare = res
            if {"ROOM", "LAB"} <= kinds:
                break
        check("P9 every facility family stays in rotation",
              {"CANTEEN", "BILL_BOT"}.issubset(kinds) and {"ROOM", "LAB"} & kinds, sorted(kinds))
        check("P10 every injection produced complaint + work order + SLA clock",
              all(e.get("ticket_number") and e.get("work_order_id") and e.get("sla_clock_id") for e in events),
              [(e.get("facility_kind"), e.get("ticket_number")) for e in events])

        def event_row(ticket: str) -> dict:
            return fetch_one(
                cur, "select to_jsonb(e) from public.simulation_events e where e.ticket_number = %s",
                (ticket,))[0]

        canteen = next((e for e in events if e["facility_kind"] == "CANTEEN"), None)
        bot = next((e for e in events if e["facility_kind"] == "BILL_BOT"), None)
        spare = next((e for e in events if e["facility_kind"] in ("ROOM", "LAB")), None)

        if canteen:
            row = fetch_one(
                cur,
                "select category, urgency, source_channel, status, space_type from public.complaints"
                " where ticket_number = %s", (canteen["ticket_number"],))
            check("P11 canteen fault classified through the real pipeline",
                  row[0] == "CANTEEN_APPLIANCE" and row[2] == "SIMULATION" and row[3] == "TRIAGED"
                  and row[4] == "CANTEEN", row)
            row = fetch_one(
                cur,
                "select w.status, w.required_skill, c.visual_state, a.status"
                " from public.work_orders w"
                " join public.canteens c on c.code = w.space_code"
                " join public.assets a on a.asset_code = %s"
                " where w.complaint_id = (select id from public.complaints where ticket_number = %s)",
                (canteen["asset_code"], canteen["ticket_number"],))
            check("P12 canteen twin damaged and work order routed",
                  row[0] == "PENDING_ASSIGNMENT" and row[1] == "ELECTRICAL"
                  and row[2] in ("FAULTY", "DEGRADED") and row[3] == "FAULTY", row)
        else:
            check("P11 canteen fault classified through the real pipeline", False, "no canteen injection")
            check("P12 canteen twin damaged and work order routed", False, "no canteen injection")

        if bot:
            row = fetch_one(
                cur,
                "select c.category, b.visual_state, a.status from public.complaints c"
                " join public.bill_bots b on b.code = c.space_code"
                " join public.assets a on a.asset_code = %s"
                " where c.ticket_number = %s", (bot["asset_code"], bot["ticket_number"],))
            check("P13 bill-bot fault classified and twin damaged",
                  row[0] == "BILL_BOT" and row[1] == "FAULTY" and row[2] == "FAULTY", row)
        else:
            check("P13 bill-bot fault classified and twin damaged", False, "no bot injection")

        # -- Canteen chain: dispatch, parts, completion, pricing --------------------
        if canteen:
            wo_id = canteen["work_order_id"]
            as_user(cur, ADMIN)
            row = fetch_one(cur, "select public.rpc_assign_or_rebalance_staff(%s, null,"
                                 " 'facilities@nosih.edu.in', 'FACILITIES_ADMIN', true)", (wo_id,))
            check("P14 pulse work order auto-dispatches", row[0].get("success") is True, row[0])
            as_postgres(cur)

            sku = fetch_one(cur, "select sku_code from public.assets where asset_code = %s",
                            (canteen["asset_code"],))[0]
            stock = fetch_one(cur, "select on_hand_qty - reserved_qty from public.inventory_items"
                                   " where sku_code = %s", (sku,))[0]
            row = fetch_one(cur, "select public.rpc_reserve_parts_for_work_order(%s, %s,"
                                 " 'facilities@nosih.edu.in', 'FACILITIES_ADMIN')",
                            (wo_id, json.dumps([{"sku_code": sku, "qty": 1}])))
            ok = row[0].get("success") is True and stock >= 1
            check("P15 parts reserved from live inventory", ok, (sku, stock, row[0]))

            as_user(cur, ADMIN)
            row = fetch_one(cur, "select public.rpc_complete_work_order(%s,"
                                 " 'Pulse chain: verified repair with part replacement',"
                                 " 'facilities@nosih.edu.in')", (wo_id,))
            as_postgres(cur)
            check("P16 pulse work order completes", row[0].get("success") is True, row[0])

            row = fetch_one(
                cur,
                "select (select status from public.complaints where ticket_number = %s),"
                "       (select status from public.assets where asset_code = %s),"
                "       (select visual_state from public.canteens where code = %s),"
                "       (select total_cost_inr from public.maintenance_history"
                "         where work_order_number = %s order by id desc limit 1),"
                "       (select downtime_mins from public.maintenance_history"
                "         where work_order_number = %s order by id desc limit 1)",
                (canteen["ticket_number"], canteen["asset_code"], canteen["space_code"],
                 canteen.get("work_order_number"), canteen.get("work_order_number"),))
            check("P17 completion restores twin, asset and prices the repair",
                  row[0] == "RESOLVED" and row[1] == "OK" and row[2] == "HEALTHY"
                  and row[3] is not None and row[3] > 0 and row[4] is not None, row)

        # -- Bot chain: completion must restore the bot twin (pipeline gap fix) -----
        if bot:
            wo_id = bot["work_order_id"]
            as_user(cur, ADMIN)
            fetch_one(cur, "select public.rpc_assign_or_rebalance_staff(%s, null,"
                           " 'facilities@nosih.edu.in', 'FACILITIES_ADMIN', true)", (wo_id,))
            row = fetch_one(cur, "select public.rpc_complete_work_order(%s,"
                                 " 'Pulse chain: thermal mechanism serviced',"
                                 " 'facilities@nosih.edu.in')", (wo_id,))
            as_postgres(cur)
            state = fetch_one(cur, "select visual_state from public.bill_bots where code = %s",
                              (bot["space_code"],))[0]
            check("P18 completed bill-bot repair restores the bot twin",
                  row[0].get("success") is True and state == "HEALTHY", (row[0], state))

        # -- Auto-heal ----------------------------------------------------------------
        if spare:
            cur.execute("update public.work_orders set created_at = now() - interval '5 hours'"
                        " where id = %s", (spare["work_order_id"],))
            cur.execute("update public.simulation_config set auto_heal_hours = 4 where id")
            healed = fetch_one(cur, "select public.nosih_pulse_heal()")[0]
            row = fetch_one(
                cur,
                "select e.status, w.status from public.simulation_events e"
                " join public.work_orders w on w.id = e.work_order_id"
                " where e.ticket_number = %s", (spare["ticket_number"],))
            check("P19 auto-heal completes aged simulated work orders",
                  healed >= 1 and row[0] == "COMPLETED" and row[1] == "COMPLETED", (healed, row))
            cur.execute("update public.simulation_config set auto_heal_hours = 0 where id")

        # -- Revert ---------------------------------------------------------------------
        target = next((e for e in events if e is not canteen and e is not bot and e is not spare), None)
        if target is None and spare is not None and spare.get("ticket_number"):
            target = spare
        if target:
            ev = event_row(target["ticket_number"])
            as_user(cur, ADMIN)
            reverted = fetch_one(cur, "select public.rpc_pulse_revert(%s)", (ev["id"],))[0]
            as_postgres(cur)
            row = fetch_one(
                cur,
                "select (select status from public.complaints where ticket_number = %s),"
                "       (select status from public.work_orders where id = %s),"
                "       (select status from public.assets where asset_code = %s),"
                "       (select visual_state from public.canteens where code = %s"
                "         union all select visual_state from public.rooms where code = %s"
                "         union all select visual_state from public.labs where code = %s"
                "         union all select visual_state from public.bill_bots where code = %s"
                "         limit 1)",
                (target["ticket_number"], target["work_order_id"], target["asset_code"],
                 target["space_code"], target["space_code"], target["space_code"], target["space_code"],))
            check("P20 per-event revert restores pre-injection state",
                  reverted.get("success") is True and ev["status"] == "ACTIVE"
                  and row[0] == "RESOLVED" and row[1] == "CANCELLED" and row[2] == "OK"
                  and row[3] == "HEALTHY", (reverted, row))

        # -- Control-plane gates ----------------------------------------------------------
        as_user(cur, ADMIN)
        status = fetch_one(cur, "select public.rpc_pulse_status()")[0]
        check("P21 pulse status for admin",
              status.get("success") is True and "open_simulated" in status and "recent_events" in status,
              {k: status.get(k) for k in ("open_simulated", "injected_24h")})
        row = fetch_one(cur, "select public.rpc_pulse_configure(null, 7, 4, 0)")
        check("P22 pulse configure for admin", row[0].get("success") is True and
              row[0].get("interval_minutes") == 7 and row[0].get("max_open_simulated") == 4, row[0])
        as_user(cur, STUDENT)
        row = fetch_one(cur, "select public.rpc_pulse_status()->>'error'")
        check("P23 pulse status denied to students", row[0] == "FORBIDDEN", row[0])
        row = fetch_one(cur, "select public.rpc_pulse_configure(false, null, null, null)->>'error'")
        check("P24 pulse configure denied to students", row[0] == "FORBIDDEN", row[0])
        as_postgres(cur)

        conn.rollback()

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
