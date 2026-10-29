"""Ad-hoc probe: submit one complaint through rpc_submit_complaint as a signed-in
user and print the resulting digital-twin state, to prove intake and twin mutate
in a single transaction."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

USER_UUID = sys.argv[1] if len(sys.argv) > 1 else "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
SPACE = sys.argv[2] if len(sys.argv) > 2 else "B2-04"
DESCRIPTION = sys.argv[3] if len(sys.argv) > 3 else (
    "Burning smell and small sparks from the ceiling fan 2 in B2-04 during the lecture."
)


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    payload = {
        "email": "diya.khan@nosih.edu",
        "full_name": "Diya Khan",
        "role": "STUDENT",
        "department_code": "CSE",
        "year_number": 3,
        "is_anonymous": False,
        "space_code": SPACE,
        "description": DESCRIPTION,
        "image_url": None,
        "target_assets": [],
        "source_channel": "WEB_PORTAL",
    }
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": USER_UUID, "role": "authenticated"}),),
            )
            cur.execute("set role authenticated")
            cur.execute("select public.rpc_submit_complaint(%s::jsonb)", (json.dumps(payload),))
            result = cur.fetchone()[0]
            print("=== rpc_submit_complaint ===")
            print(json.dumps(result, indent=2, default=str)[:2600])

            complaint_id = (result.get("complaint") or {}).get("id")
            if not complaint_id:
                conn.rollback()
                return

            # Inspection runs as the owner; RLS would hide twin rows from `authenticated`.
            cur.execute("set role postgres")

            cur.execute(
                """select id, ticket_number, status, category, urgency, ai_status, moderation_status,
                          ai_extracted_json::text, missing_info_questions_json::text
                     from public.complaints where id = %s""",
                (complaint_id,),
            )
            print("=== complaint ===")
            print(cur.fetchone())

            cur.execute(
                """select id, status, required_skill, required_risk_clearance, priority_score,
                          target_asset_codes_json::text
                     from public.work_orders where complaint_id = %s order by id desc limit 1""",
                (complaint_id,),
            )
            print("=== work order ===")
            print(cur.fetchone())
            cur.execute("select count(*) from public.work_orders")
            print("work order total:", cur.fetchone()[0])

            cur.execute(
                """select target_type, response_target_mins, resolution_target_mins,
                          elapsed_active_mins, is_paused, breach_state
                     from public.sla_clocks
                    where target_id in (select id from public.work_orders where complaint_id = %s)""",
                (complaint_id,),
            )
            print("=== sla clocks ===")
            for row in cur.fetchall():
                print(row)

            cur.execute(
                """select a.asset_code, a.status, a.failure_count_30d
                     from public.assets a
                    where a.asset_code in (
                      select jsonb_array_elements_text(wo.target_asset_codes_json::jsonb)
                        from public.work_orders wo where wo.complaint_id = %s)""",
                (complaint_id,),
            )
            print("=== assets ===")
            for row in cur.fetchall():
                print(row)

            cur.execute("select code, visual_state from public.rooms where code = %s", (SPACE,))
            print("=== room state ===")
            print(cur.fetchone())

            cur.execute(
                """select id, root_cause_key, status from public.incidents
                    where id = (select linked_incident_id from public.complaints where id = %s)""",
                (complaint_id,),
            )
            print("=== incident ===")
            print(cur.fetchone())

            cur.execute(
                """select action, actor_email, context_json::text
                     from public.audit_logs order by id desc limit 4""",
            )
            print("=== recent audit ===")
            for row in cur.fetchall():
                print(row[0], row[1], (row[2] or "")[:160])
        conn.commit()
        with conn.cursor() as cur:
            cur.execute(
                "select id, ticket_number, status, ai_status from public.complaints where id = %s",
                (complaint_id,),
            )
            print("=== committed complaint ===")
            print(cur.fetchone())
            cur.execute(
                "select id, wo_number, status, required_skill, priority_score from public.work_orders where complaint_id = %s",
                (complaint_id,),
            )
            print("=== committed work order ===")
            print(cur.fetchone())
            cur.execute(
                "select target_type, response_target_mins, resolution_target_mins, breach_state from public.sla_clocks where target_id in (select id from public.work_orders where complaint_id = %s)",
                (complaint_id,),
            )
            print("=== committed sla ===")
            print(cur.fetchone())


if __name__ == "__main__":
    main()
