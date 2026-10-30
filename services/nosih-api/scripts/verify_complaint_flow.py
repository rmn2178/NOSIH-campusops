"""Submit a real complaint through rpc_submit_complaint and assert that every
digital-twin side effect landed in the same transaction, then roll back.

This proves registration works end to end without polluting the demo data.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect, enable_utf8_stdout  # noqa: E402

enable_utf8_stdout()

STUDENT_UUID = "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
SPACE = "A1-02"
DESCRIPTION = (
    "Water is leaking from the ceiling pipe in A1-02 and dripping onto the front benches; "
    "the floor near the door is already wet."
)

failures: list[str] = []


def check(label: str, condition: bool, detail: object = "") -> None:
    print(("PASS  " if condition else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not condition:
        failures.append(label)


def main() -> None:
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("select set_config('request.jwt.claims', %s, false)",
                    (json.dumps({"sub": STUDENT_UUID, "role": "authenticated"}),))
        cur.execute("set role authenticated")

        payload = {
            "email": "aids1a01@nosih.edu.in",
            "full_name": "Aarav Menon",
            "role": "STUDENT",
            "is_anonymous": False,
            "space_code": SPACE,
            "description": DESCRIPTION,
            "image_url": None,
            "target_assets": [],
            "source_channel": "WEB_PORTAL",
        }
        cur.execute("select public.rpc_submit_complaint(%s::jsonb)", (json.dumps(payload),))
        result = cur.fetchone()[0]
        check("intake returns success", result.get("success") is True, result.get("error"))

        complaint = result.get("complaint") or {}
        cid = complaint.get("id")
        check("complaint has a ticket", str(complaint.get("ticket_number", "")).startswith("CMP-"), complaint.get("ticket_number"))
        check("moderation approved", result.get("moderation_status") == "APPROVED", result.get("moderation_status"))
        check("category detected as plumbing", complaint.get("category") == "PLUMBING", complaint.get("category"))
        check("urgency not trivial", complaint.get("urgency") in ("MEDIUM", "HIGH", "CRITICAL"), complaint.get("urgency"))
        check("space resolved to A1-02", complaint.get("space_code") == SPACE, complaint.get("space_code"))
        check("twin state is faulty/degraded", complaint.get("twin_state") in ("FAULTY", "DEGRADED"), complaint.get("twin_state"))
        first = result.get("first_response") or {}
        check("first response carries SLA target", (first.get("sla_target_minutes") or 0) > 0, first.get("sla_target_minutes"))
        check("clarifying questions asked", isinstance(first.get("missing_info_questions"), list), len(first.get("missing_info_questions") or []))
        check("duplicate merge not triggered", first.get("merged_duplicate") is False, first.get("merged_duplicate"))

        cur.execute("set role postgres")
        cur.execute("select status, ai_status, ai_extracted_json from public.complaints where id = %s", (cid,))
        status, ai_status, extracted = cur.fetchone()
        check("complaint stored TRIAGED", status == "TRIAGED", status)
        check("AI enrichment applied in-transaction", ai_status == "APPLIED", ai_status)
        check("AI engine recorded", "ai_engine" in (extracted or ""), (extracted or "")[:80])
        check("no equipment falsely flagged for a plumbing leak", "LED-A1-02" not in (extracted or ""), (extracted or "")[:120])

        cur.execute("""select id, status, required_skill, priority_score, target_asset_codes_json
                         from public.work_orders where complaint_id = %s""", (cid,))
        row = cur.fetchone()
        check("work order created", row is not None)
        if row:
            wo_id, wo_status, skill, priority, assets = row
            check("work order pending assignment", wo_status == "PENDING_ASSIGNMENT", wo_status)
            check("work order skill is plumbing", skill == "PLUMBING", skill)
            check("priority reflects urgency", float(priority) >= 50, priority)

            cur.execute("""select response_target_mins, resolution_target_mins, is_paused
                             from public.sla_clocks where target_type = 'WORK_ORDER' and target_id = %s""", (wo_id,))
            clock = cur.fetchone()
            check("SLA clock created", clock is not None, clock)
            if clock:
                check("SLA targets match urgency", clock[0] in (10, 30, 120, 240) and clock[1] in (60, 240, 1440, 2880), clock[:2])
                check("SLA clock running", clock[2] is False, clock[2])

        cur.execute("select visual_state from public.rooms where code = %s", (SPACE,))
        state = cur.fetchone()[0]
        check("room state reflects the fault", state in ("DEGRADED", "FAULTY"), state)

        cur.execute("""select action, outcome from public.audit_logs
                        where resource_type = 'COMPLAINT' and resource_id = %s
                        order by id desc limit 3""", (str(cid),))
        rows = cur.fetchall()
        check("AI severity indicators stored", "severity_indicators" in (extracted or ""), (extracted or "")[-60:])
        if rows:
            print(f"      (audit: {rows[0][0]} / {rows[0][1]})")

        cur.execute("select count(*) from public.complaint_votes where complaint_id = %s", (cid,))
        check("reporter vote seeded", cur.fetchone()[0] == 1)

        conn.rollback()
        print("\n(transaction rolled back — demo data unchanged)")

    print("RESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
