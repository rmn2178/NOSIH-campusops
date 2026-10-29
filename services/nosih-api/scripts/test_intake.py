"""Exercise complaint intake, feed, comment and anonymous vault RPCs."""

from __future__ import annotations

import json
import sys

from sqlalchemy import text

sys.path.insert(0, ".")

from app.database import engine  # noqa: E402


def main() -> None:
    with engine.connect() as conn:
        trans = conn.begin()

        def scalar(sql: str, **params):
            return conn.execute(text(sql), params).scalar_one()

        payload = {
            "email": "aids1a01@nosih.edu.in",
            "full_name": "Aarav Sharma",
            "role": "STUDENT",
            "department_code": "AIDS",
            "year_number": 1,
            "is_anonymous": False,
            "space_code": "C4-03",
            "description": "The ceiling fans and lights stopped working and there is smoke near the smart board.",
            "target_assets": [
                {"asset_type": "CEILING_FAN", "asset_codes": ["FAN-C4-03-01", "FAN-C4-03-02"]},
                {"asset_type": "SMART_BOARD", "asset_codes": ["SB-C4-03-01"]},
            ],
            "source_channel": "WEB_PORTAL",
        }
        result = scalar("select public.rpc_submit_complaint(cast(:p as jsonb))", p=json.dumps(payload))
        complaint = result.get("complaint") or {}
        print("submit:", result.get("success"), complaint.get("ticket_number"),
              complaint.get("category"), complaint.get("urgency"), complaint.get("status"),
              "assets:", len(complaint.get("target_assets") or []))

        complaint_id = complaint.get("id")
        print("twin:", scalar("select visual_state from public.rooms where code='C4-03'"))
        print("work order:", scalar(
            "select wo_number || ' / ' || status from public.work_orders where complaint_id=:id", id=complaint_id
        ))
        print("sla:", scalar(
            "select breach_state || ' / ' || resolution_target_mins from public.sla_clocks s "
            "join public.work_orders w on w.id=s.target_id where w.complaint_id=:id", id=complaint_id
        ))

        anon = {
            "email": "aids1a02@nosih.edu.in",
            "role": "STUDENT",
            "department_code": "AIDS",
            "year_number": 1,
            "is_anonymous": True,
            "space_code": "C4-04",
            "description": "There is a water leak from the ceiling in C4-04.",
            "source_channel": "WEB_PORTAL",
        }
        anon_result = scalar("select public.rpc_submit_complaint(cast(:p as jsonb))", p=json.dumps(anon))
        anon_complaint = anon_result.get("complaint") or {}
        print("anonymous:", anon_result.get("success"), anon_complaint.get("ticket_number"),
              "label:", anon_complaint.get("reporter_label"),
              "vault rows:", scalar(
                  "select count(*) from public.identity_vault where target_entity_id=:id",
                  id=anon_complaint.get("id"),
              ))

        comment = scalar(
            "select public.rpc_post_comment(cast(:p as jsonb))",
            p=json.dumps({
                "complaint_id": complaint_id,
                "email": "aids1a03@nosih.edu.in",
                "body": "Same issue in our room too.",
                "is_anonymous": True,
            }),
        )
        print("comment:", comment.get("success"), (comment.get("comment") or {}).get("author_label"))

        listed = scalar("select public.rpc_list_complaints('ALL',null,null,false,10)")
        print("feed:", len(listed))

        got = scalar("select public.rpc_get_complaint(:id)", id=complaint_id)
        print("detail:", got.get("ticket_number"), "comments:", len(got.get("comments") or []))

        print("audit rows in tx:", scalar("select count(*) from public.audit_logs"))
        trans.rollback()
        print("rolled back")


if __name__ == "__main__":
    main()
