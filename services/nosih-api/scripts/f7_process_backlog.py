"""F7: shape the demo backlog through the real pipeline.

Leaves exactly four pending complaints — two classrooms, one canteen, one lab —
and processes everything else through the same RPCs the portals use:

  * paused pulse so the shaped state holds (the panel can resume it)
  * one LAB fault injected via the pulse engine so every pending facility type
    is represented (none was open at the time)
  * non-keeper pulse events reverted through rpc_pulse_revert
  * open work orders assigned (auto, five gates) and completed with pricing,
    twin restore and SLA closure
  * complaint-only rows resolved through rpc_update_complaint_status

Keepers:
  CMP-2026-0081  C5-02   classroom · web portal · projector flicker + fan
  CMP-2026-0085  A1-01   classroom · chat · fan rattling (manageable)
  CMP-2026-0302  CAN-05  canteen · simulation · warmer cold (assigned)
  <injected lab ticket>  lab · simulation
"""

import json
import os
from urllib.parse import urlsplit, urlunsplit

import psycopg
from dotenv import load_dotenv

ADMIN_UUID = "4642ba88-5b19-458e-b9c0-84e70e04f060"
ADMIN_EMAIL = "facilities@nosih.edu.in"
KEEPERS = {"CMP-2026-0081", "CMP-2026-0085", "CMP-2026-0302"}
COMPLETION_NOTE = "Backlog processed: technician verified the repair and the space was returned to service."


def connect():
    load_dotenv("services/nosih-api/.env")
    url = os.environ["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)
    try:
        return psycopg.connect(url, connect_timeout=8)
    except psycopg.OperationalError:
        parts = urlsplit(url)
        proj = (parts.hostname or "").removeprefix("db.").removesuffix(".supabase.co")
        netloc = f"postgres.{proj}:{parts.password}@aws-0-eu-west-1.pooler.supabase.com:{parts.port or 5432}"
        return psycopg.connect(
            urlunsplit((parts.scheme, netloc, parts.path, parts.query, "")),
            connect_timeout=10,
            sslmode="require",
        )


def as_admin(cur):
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": ADMIN_UUID, "role": "authenticated"}),))
    cur.execute("set role authenticated")


def as_postgres(cur):
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', '', false)")


def one(cur, sql, params=()):
    cur.execute(sql, params)
    row = cur.fetchone()
    return None if row is None else row[0]


def main() -> None:
    conn = connect()
    conn.autocommit = True
    cur = conn.cursor()
    keepers = set(KEEPERS)
    actions = 0

    # 0. Hold the clock: the pulse must not inject while we shape the board.
    as_admin(cur)
    paused = one(cur, "select public.rpc_pulse_configure(false, null, null, null)")
    as_postgres(cur)
    print(f"pulse paused: {paused.get('success')} enabled={paused.get('enabled')}")

    # 1. Inject one lab fault so the pending set covers all four facility types
    #    (skipped when a lab complaint is already open, so reruns stay idempotent).
    existing_lab = cur.execute(
        """select c.ticket_number from public.complaints c
            where c.space_type = 'LAB'
              and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS')"""
    ).fetchall()
    if existing_lab:
        for (ticket,) in existing_lab:
            keepers.add(ticket)
            print(f"lab fault already open: {ticket}")
    else:
        for table in ("canteens", "rooms", "bill_bots"):
            cur.execute(f"update public.{table} set visual_state = 'MASKED' where visual_state = 'HEALTHY'")
        lab = one(cur, "select public.nosih_pulse_inject()")
        for table in ("canteens", "labs", "rooms", "bill_bots"):
            cur.execute(f"update public.{table} set visual_state = 'HEALTHY' where visual_state = 'MASKED'")
        if not lab.get("fired") or lab.get("facility_kind") != "LAB":
            raise SystemExit(f"lab injection failed: {lab}")
        keepers.add(lab["ticket_number"])
        actions += 1
        print(f"lab fault injected: {lab['ticket_number']} · {lab['space_code']} · {lab['work_order_number']}")

    # 2. Revert every non-keeper pulse event (resolves complaint, cancels WO,
    #    restores assets and bot state through the recorded prior state).
    events = cur.execute(
        "select id, ticket_number, space_code from public.simulation_events where status = 'ACTIVE'"
    ).fetchall()
    for event_id, ticket, space in events:
        if ticket in keepers:
            continue
        as_admin(cur)
        result = one(cur, "select public.rpc_pulse_revert(%s)", (event_id,))
        as_postgres(cur)
        ok = result.get("success") is True
        print(f"pulse revert {ticket} @ {space}: {'ok' if ok else result}")
        actions += 1

    # 3. Process every remaining open complaint that is not a keeper.
    open_rows = cur.execute(
        """select c.id, c.ticket_number, c.space_code, c.space_type, c.status,
                  w.id as wo_id, w.status as wo_status
             from public.complaints c
             left join public.work_orders w on w.complaint_id = c.id
            where c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS')
            order by c.id"""
    ).fetchall()
    for cid, ticket, space, space_type, status, wo_id, wo_status in open_rows:
        if ticket in keepers:
            print(f"keeper held: {ticket} · {space} · {status}")
            continue
        if wo_id is None:
            as_admin(cur)
            res = one(cur, "select public.rpc_update_complaint_status(%s, 'RESOLVED', %s)", (cid, ADMIN_EMAIL))
            as_postgres(cur)
            print(f"resolved {ticket} @ {space}: {'ok' if res.get('success', True) else res.get('error')}")
            actions += 1
            continue

        if wo_status in ("PENDING_ASSIGNMENT",):
            as_admin(cur)
            assigned = one(
                cur,
                "select public.rpc_assign_or_rebalance_staff(%s, null, %s, 'FACILITIES_ADMIN', true)",
                (wo_id, ADMIN_EMAIL),
            )
            as_postgres(cur)
            if not assigned.get("success"):
                print(f"assign FAILED {ticket}: {assigned}")
                continue

        as_admin(cur)
        done = one(cur, "select public.rpc_complete_work_order(%s, %s, %s)",
                   (wo_id, COMPLETION_NOTE, ADMIN_EMAIL))
        as_postgres(cur)
        if done.get("success"):
            print(f"completed {ticket} @ {space} (wo {done.get('work_order_number')})")
        else:
            as_admin(cur)
            res = one(cur, "select public.rpc_update_complaint_status(%s, 'RESOLVED', %s)", (cid, ADMIN_EMAIL))
            as_postgres(cur)
            print(f"complete failed {ticket}: {done.get('error')} -> status resolve: {res.get('success', True)}")
        actions += 1

    # 3b. Close stale work orders whose complaint was already resolved — a
    #     work order must never outlive its ticket in the dispatch queue.
    stale = cur.execute(
        """select w.id, w.wo_number from public.work_orders w
            where w.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS')
              and w.complaint_id is not null
              and exists (select 1 from public.complaints c
                           where c.id = w.complaint_id and c.status = 'RESOLVED')"""
    ).fetchall()
    for wo_id, wo_number in stale:
        as_admin(cur)
        done = one(cur, "select public.rpc_complete_work_order(%s, %s, %s)",
                   (wo_id, "Housekeeping: repair closed under the already-resolved ticket.", ADMIN_EMAIL))
        as_postgres(cur)
        print(f"closed stale {wo_number}: {'ok' if done.get('success') else done.get('error')}")
        actions += 1

    # 4. Final truth: exactly the four keepers stay open.
    remaining = cur.execute(
        """select c.ticket_number, c.space_code, c.space_type, c.status,
                  coalesce(w.wo_number, '-'), coalesce(w.status, '-')
             from public.complaints c
             left join public.work_orders w on w.complaint_id = c.id
            where c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS')
            order by c.space_type, c.space_code"""
    ).fetchall()
    twin = cur.execute(
        """select 'ROOM' kind, code, visual_state from public.rooms where visual_state <> 'HEALTHY'
           union all select 'LAB', code, visual_state from public.labs where visual_state <> 'HEALTHY'
           union all select 'CANTEEN', code, visual_state from public.canteens where visual_state <> 'HEALTHY'
           union all select 'BOT', code, visual_state from public.bill_bots where visual_state <> 'HEALTHY'
           order by 1, 2"""
    ).fetchall()
    config = cur.execute("select enabled, interval_minutes, max_open_simulated, auto_heal_hours"
                         " from public.simulation_config").fetchone()
    orphans = one(cur,
                  """select count(*) from public.work_orders w
                      where w.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS')
                        and (w.complaint_id is null or not exists (
                              select 1 from public.complaints c
                               where c.id = w.complaint_id
                                 and c.status in ('OPEN', 'TRIAGED', 'IN_PROGRESS', 'BLOCKED_PARTS')))""")

    print(f"\nremaining open complaints: {len(remaining)}")
    for row in remaining:
        print("  ", " · ".join(str(v) for v in row))
    print("non-healthy twin spaces:")
    for row in twin:
        print("  ", " · ".join(str(v) for v in row))
    print(f"pulse config: enabled={config[0]} interval={config[1]}m cap={config[2]} auto_heal={config[3]}h")

    kinds = sorted(row[2] for row in remaining)
    open_wo = [row[5] for row in remaining if row[5] not in ("-",)]
    paused_ok = config[0] is False

    checks = [
        ("four complaints stay open", len(remaining) == 4),
        ("two classrooms, one canteen, one lab", kinds == ["CANTEEN", "LAB", "ROOM", "ROOM"]),
        ("every keeper is still actionable", all(s in ("TRIAGED", "OPEN", "IN_PROGRESS", "BLOCKED_PARTS") for _, _, _, s, _, _ in remaining)),
        ("keepers keep open work orders", all(s in ("PENDING_ASSIGNMENT", "ASSIGNED", "IN_PROGRESS", "BLOCKED_PARTS") for s in open_wo)),
        ("pulse holds the shaped state", paused_ok),
        ("twin shows exactly the four faulted spaces", len(twin) == 4),
        ("no orphan work orders left behind", orphans == 0),
    ]
    ok = True
    print()
    for label, passed in checks:
        print(f"{'PASS' if passed else 'FAIL'}  {label}")
        ok = ok and passed
    print(f"\n{actions} pipeline actions · {'ALL PASS' if ok else 'FAILED'}")
    conn.close()
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
