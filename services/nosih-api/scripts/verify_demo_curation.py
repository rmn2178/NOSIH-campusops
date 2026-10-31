"""Demo gate: exactly one classroom fault pair, one lab bench and one bill bot.

The public complaint feed defaults to live reports, the twin colours only the
three curated spaces, and every repaired ticket keeps its work order and
service history. Read-only; prints ALL PASS.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def one(cur, sql: str, params: tuple = ()):
    cur.execute(sql, params)
    return cur.fetchone()


def main() -> None:
    with connect() as conn:
        cur = conn.cursor()

        active = cur.execute(
            """
            select id, ticket_number, space_type, space_code, status, urgency, category,
                   ai_extracted_json
              from public.complaints
             where moderation_status = 'APPROVED'
               and status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE')
             order by created_at desc
            """
        ).fetchall()
        check("D1 exactly three live complaints", len(active) == 3,
              [(row[1], row[4]) for row in active])
        by_space = {row[3]: row for row in active}
        check("D2 live spaces are C1-02, BOT-03 and LAB-PHYS-04",
              set(by_space) == {"C1-02", "BOT-03", "LAB-PHYS-04"}, sorted(by_space))

        c1 = by_space.get("C1-02")
        if c1:
            targets = c1[7]
            codes = sorted(t["asset_code"] for t in json.loads(targets)["target_assets"])
            check("D3 C1-02 targets the front-row fan and light only",
                  codes == ["FAN-C1-02-01", "LED-C1-02-01"], codes)
            wo = one(cur, "select target_asset_codes_json from public.work_orders where complaint_id = %s", (c1[0],))
            wo_codes = sorted(json.loads(wo[0])) if wo else []
            check("D4 C1-02 work order carries the same two assets",
                  wo_codes == ["FAN-C1-02-01", "LED-C1-02-01"], wo_codes)

        lab = by_space.get("LAB-PHYS-04")
        if lab:
            codes = [t["asset_code"] for t in json.loads(lab[7])["target_assets"]]
            check("D5 lab report carries one bench", codes == ["INST-LAB-PHYS-04-14"], codes)

        bot = by_space.get("BOT-03")
        if bot:
            codes = [t["asset_code"] for t in json.loads(bot[7])["target_assets"]]
            check("D6 bill-bot report carries one mechanism", codes == ["MECH-BOT-03-01"], codes)
            check("D7 bill-bot ticket is live", bot[4] == "TRIAGED" and bot[5] == "HIGH",
                  (bot[4], bot[5]))

        faulty = cur.execute(
            "select parent_space_code, count(*) from public.assets "
            "where status = 'FAULTY' group by 1 order by 1"
        ).fetchall()
        check("D8 four faulty assets across exactly three spaces",
              dict(faulty) == {"BOT-03": 1, "C1-02": 2, "LAB-PHYS-04": 1}, faulty)
        check("D9 every other asset is operational",
              one(cur, "select count(*) from public.assets where status not in ('OK','DEGRADED')")[0] == 4,
              one(cur, "select count(*) from public.assets where status not in ('OK','DEGRADED')")[0])

        states = cur.execute(
            """
            select 'ROOM' as kind, code, visual_state from public.rooms where visual_state <> 'HEALTHY'
            union all select 'LAB', code, visual_state from public.labs where visual_state <> 'HEALTHY'
            union all select 'CANTEEN', code, visual_state from public.canteens where visual_state <> 'HEALTHY'
            union all select 'BOT', code, visual_state from public.bill_bots where visual_state <> 'HEALTHY'
            order by 1, 2
            """
        ).fetchall()
        check("D10 twin colours only the three live spaces",
              states == [("BOT", "BOT-03", "FAULTY"), ("LAB", "LAB-PHYS-04", "FAULTY"),
                         ("ROOM", "C1-02", "FAULTY")], states)

        bots = cur.execute(
            "select code, visual_state, rerouted_to_bot_code from public.bill_bots order by code"
        ).fetchall()
        check("D11 only BOT-03 is faulty", [b for b in bots if b[1] == "FAULTY"] ==
              [("BOT-03", "FAULTY", "BOT-04")], [b for b in bots if b[1] == "FAULTY"])
        check("D12 healthy bill bots are not rerouted",
              all(b[2] is None for b in bots if b[0] != "BOT-03"), bots)

        feed = one(cur, "select public.rpc_list_complaints('ALL', 'ACTIVE', null, false, 10)")[0]
        check("D13 feed defaults to three active reports", len(feed) == 3, len(feed))
        check("D14 active feed is newest first",
              [row["space_code"] for row in feed] == ["C1-02", "BOT-03", "LAB-PHYS-04"],
              [row["space_code"] for row in feed])
        everything = one(cur, "select public.rpc_list_complaints('ALL', 'ALL', null, false, 10)")[0]
        check("D15 history stays reachable behind the active filter",
              len(everything) == 10 and all(row["status"] not in ("RESOLVED", "CLOSED") for row in everything[:3]),
              [row["status"] for row in everything[:3]])

        open_wos = cur.execute(
            "select complaint_id, space_code, status from public.work_orders "
            "where status in ('PENDING_ASSIGNMENT','ASSIGNED','IN_PROGRESS','BLOCKED_PARTS') order by id"
        ).fetchall()
        check("D16 exactly three live work orders", len(open_wos) == 3,
              [(row[1], row[2]) for row in open_wos])
        check("D17 every live work order belongs to a live ticket",
              {row[0] for row in open_wos} == {row[0] for row in active},
              sorted(row[0] for row in open_wos))

        repaired = cur.execute(
            """
            select c.ticket_number, w.status, w.completed_at,
                   (select count(*) from public.maintenance_history m
                     where m.work_order_number = w.wo_number)
              from public.complaints c
              join public.work_orders w on w.complaint_id = c.id
             where c.ticket_number in ('CMP-2026-0302', 'CMP-2026-0085', 'CMP-2026-0081')
            """
        ).fetchall()
        check("D18 repaired tickets are closed with history",
              len(repaired) == 3 and all(row[1] == "COMPLETED" and row[2] is not None and row[3] > 0
                                         for row in repaired), repaired)

        bot_sla = one(
            cur,
            """
            select sc.breach_state, sc.is_paused
              from public.sla_clocks sc
              join public.work_orders w on w.id = sc.target_id
              join public.complaints c on c.id = w.complaint_id
             where sc.target_type = 'WORK_ORDER' and c.space_code = 'BOT-03'
            """,
        )
        check("D19 bill-bot clock is live and healthy", bot_sla == ("HEALTHY", False), bot_sla)

        stale_events = one(
            cur,
            """
            select count(*) from public.simulation_events e
              join public.complaints c on c.id = e.complaint_id
             where e.status = 'ACTIVE' and c.status in ('RESOLVED', 'CLOSED')
            """,
        )[0]
        check("D20 no active simulation event points at a repaired ticket", stale_events == 0, stale_events)

        comments = cur.execute(
            """
            select c.space_code, count(*)
              from public.complaint_comments cc
              join public.complaints c on c.id = cc.complaint_id
             where cc.moderation_status = 'APPROVED'
               and c.status not in ('RESOLVED', 'CLOSED', 'MERGED_DUPLICATE')
             group by 1 order by 1
            """
        ).fetchall()
        check("D21 every live ticket carries a conversation",
              len(comments) == 3 and all(row[1] >= 2 for row in comments), comments)

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
