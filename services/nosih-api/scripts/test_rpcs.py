"""Exercise the transactional RPCs inside one rolled-back transaction."""

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

        facilities_auth = scalar("select auth_user_id from public.users where email = 'facilities@nosih.edu.in'")
        conn.execute(
            text("select set_config('request.jwt.claims', :claims, false)"),
            {"claims": json.dumps({"sub": str(facilities_auth), "role": "authenticated"})},
        )

        inspector = scalar("select public.rpc_get_space_twin_inspector(:s)", s="C4-03")
        print("inspector:", inspector.get("code"), "assets:", len(inspector.get("assets", [])),
              "timeline:", len(inspector.get("full_day_timeline", [])),
              "current:", (inspector.get("period_cards") or {}).get("current_period", {}).get("class_code"))

        lock_one = scalar(
            "select public.rpc_claim_resource_lock('ROOM','C4-03','facilities@nosih.edu.in','Facilities Admin','FACILITIES_ADMIN',300)"
        )
        lock_two = scalar(
            "select public.rpc_claim_resource_lock('ROOM','C4-03','incident@nosih.edu.in','Incident Manager','INCIDENT_MANAGER',300)"
        )
        print("lock first:", lock_one.get("success"), "second:", lock_two.get("error"))

        candidates = scalar("select public.rpc_get_room_relocation_candidates('C4-03','MON',3)")
        print("relocation:", len(candidates.get("available_candidates", [])), "available,",
              len(candidates.get("unavailable_rooms", [])), "unavailable", "session:",
              (candidates.get("session") or {}).get("class_code"))

        if candidates.get("available_candidates"):
            target = candidates["available_candidates"][0]["room_code"]
            scalar(
                "select public.rpc_claim_resource_lock('ROOM',:r,'facilities@nosih.edu.in','Facilities Admin','FACILITIES_ADMIN',300)",
                r=target,
            )
            relocated = scalar(
                "select public.rpc_execute_room_relocation('C4-03',:r,'MON',3,'facilities@nosih.edu.in','FACILITIES_ADMIN')",
                r=target,
            )
            print("execute relocation:", relocated.get("success"), relocated.get("error"),
                  (relocated.get("relocation") or {}).get("to_room"))

        work_order_id = scalar("select id from public.work_orders order by id limit 1")
        ranking = scalar("select public.rpc_rank_staff_for_work_order(:id)", id=work_order_id)
        print("ranking:", len(ranking.get("available_ranked", [])), "available,",
              len(ranking.get("unavailable_staff", [])), "unavailable")

        if ranking.get("available_ranked"):
            staff = ranking["available_ranked"][0]["staff_code"]
            scalar(
                "select public.rpc_claim_resource_lock('STAFF',:s,'facilities@nosih.edu.in','Facilities Admin','FACILITIES_ADMIN',300)",
                s=staff,
            )
            assigned = scalar(
                "select public.rpc_assign_or_rebalance_staff(:id,:s,'facilities@nosih.edu.in','FACILITIES_ADMIN',false,null)",
                id=work_order_id, s=staff,
            )
            print("assign staff:", assigned.get("success"), assigned.get("assigned_staff_code"))
            shift = scalar(
                "select public.rpc_trigger_staff_shift_change(:s,false,'facilities@nosih.edu.in')",
                s=staff,
            )
            print("shift change:", shift.get("success"), shift.get("reassigned"))

        shortage = scalar(
            "select public.rpc_reserve_parts_for_work_order("
            ":id, cast(:parts as jsonb), 'facilities@nosih.edu.in', 'FACILITIES_ADMIN')",
            id=work_order_id,
            parts=json.dumps([{"sku_code": "SKU-FAN-CAP", "qty": 2}]),
        )
        print("parts:", shortage.get("success"), shortage.get("error"), shortage.get("work_order_status"))

        pr_id = scalar(
            "insert into public.purchase_requests (pr_number, department_code, sku_code, quantity_requested, "
            "unit_cost_inr, total_cost_inr, requested_by_user_id, status, requires_dual_approval, created_at) "
            "values ('PR-TEST-0001','CSE','SKU-FAN-CAP',1,85,85,"
            "(select id from public.users where email='procurement@nosih.edu.in'),'PENDING_APPROVAL',false,now()) returning id"
        )
        self_approval = scalar(
            "select public.rpc_decide_purchase_request(:id,'APPROVE',null,'procurement@nosih.edu.in','PROCUREMENT_APPROVER',false,null,null)",
            id=pr_id,
        )
        print("procurement self-approval:", self_approval.get("success"), self_approval.get("rule_fired"))

        pr_two = scalar(
            "insert into public.purchase_requests (pr_number, department_code, sku_code, quantity_requested, "
            "unit_cost_inr, total_cost_inr, requested_by_user_id, status, requires_dual_approval, created_at) "
            "values ('PR-TEST-0002','CSE','SKU-FAN-MOTOR',2,1200,2400,"
            "(select id from public.users where email='incident@nosih.edu.in'),'PENDING_APPROVAL',false,now()) returning id"
        )
        approved = scalar(
            "select public.rpc_decide_purchase_request(:id,'APPROVE',null,'procurement@nosih.edu.in','PROCUREMENT_APPROVER',false,null,null)",
            id=pr_two,
        )
        received = scalar(
            "select public.rpc_receive_purchase_request_stock(:id,'procurement@nosih.edu.in')",
            id=pr_two,
        )
        print("procurement approve:", approved.get("success"), approved.get("outcome"),
              "receive:", received.get("success"), received.get("status"))

        seal = scalar(
            "select public.rpc_seal_identity_in_vault('COMPLAINT', 999, cast(:identity as jsonb), 'voter-hash')",
            identity=json.dumps({"email": "student@nosih.edu.in", "full_name": "Test Student"}),
        )
        unseal = scalar(
            "select public.rpc_break_glass_unseal_identity(:token,'sysadmin@nosih.edu.in','SYSTEM_ADMIN',"
            "'Investigating a severe safety incident reported anonymously')",
            token=seal["vault_token"],
        )
        print("vault:", bool(seal.get("vault_token")), unseal.get("success"), unseal.get("identity"))

        audit = scalar(
            "select public.rpc_verify_audit_chain()"
        )
        print("audit:", audit)

        rejected = scalar(
            "select count(*) from public.audit_logs where rule_fired='SEPARATION_OF_DUTIES_SELF_APPROVAL_FORBIDDEN'"
        )
        print("rejected audit rows in transaction:", rejected)

        trans.rollback()
        print("rolled back")


if __name__ == "__main__":
    main()
