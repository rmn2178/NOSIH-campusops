"""F6 workforce gate: 30 technicians, every open job rankable and assignable.

Runs in one transaction and rolls back. Prints ALL PASS.
"""

import json
import os
from urllib.parse import urlsplit, urlunsplit

import psycopg
from dotenv import load_dotenv

ADMIN_UUID = "4642ba88-5b19-458e-b9c0-84e70e04f060"
ADMIN_EMAIL = "facilities@nosih.edu.in"
STUDENT_UUID = "00000000-0000-0000-0000-000000000099"


def connect():
    load_dotenv("services/nosih-api/.env")
    url = os.environ["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)
    try:
        return psycopg.connect(url, connect_timeout=8)
    except psycopg.OperationalError:
        parts = urlsplit(url)
        proj = (parts.hostname or "").removeprefix("db.").removesuffix(".supabase.co")
        netloc = f"postgres.{proj}:{parts.password}@aws-0-eu-west-1.pooler.supabase.com:{parts.port or 5432}"
        return psycopg.connect(urlunsplit((parts.scheme, netloc, parts.path, parts.query, "")),
                               connect_timeout=10, sslmode="require")


failures = []


def check(label, passed, detail=None):
    print(f"{'PASS' if passed else 'FAIL'}  {label}" + (f"  -> {detail}" if detail is not None else ""))
    if not passed:
        failures.append(label)


def as_user(cur, uuid):
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": uuid, "role": "authenticated"}),))
    cur.execute("set role authenticated")


def as_postgres(cur):
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', '', false)")


def one(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchone()


def rank(cur, wo_id):
    as_user(cur, ADMIN_UUID)
    res = one(cur, "select public.rpc_rank_staff_for_work_order(%s)", (wo_id,))[0]
    as_postgres(cur)
    return res


def make_wo(cur, number, skill, risk="STANDARD"):
    return one(cur, """insert into public.work_orders
        (wo_number, space_code, priority_score, required_skill, required_risk_clearance,
         status, target_asset_codes_json, estimated_cost_inr, reassignment_count,
         assignment_score_breakdown_json, created_at)
        values (%s, 'C4-04', 50, %s, %s, 'PENDING_ASSIGNMENT', '[]', 0, 0, '{}'::jsonb, now())
        returning id""", (number, skill, risk))[0]


def main():
    conn = connect()
    cur = conn.cursor()

    # -- Roster ----------------------------------------------------------------
    row = one(cur, """select count(*), count(distinct u.full_name),
                             count(*) filter (where sp.is_on_shift and not sp.is_on_leave)
                        from public.staff_profiles sp join public.users u on u.id = sp.user_id
                       where sp.staff_category = 'MAINTENANCE_TECH'""")
    check("W1 thirty technicians with unique names", row[0] == 30 and row[1] == 30, row)
    check("W2 twenty-eight on shift", row[2] == 28, row[2])

    skills = cur.execute("""select primary_skill, count(*),
                                   count(*) filter (where is_on_shift and not is_on_leave)
                              from public.staff_profiles
                             where staff_category = 'MAINTENANCE_TECH'
                             group by 1 order by 1""").fetchall()
    weak = [s for s in skills if s[2] < 2 or s[1] < 2]
    check("W3 every skill has at least two on-shift technicians", not weak and len(skills) >= 5, skills)

    # -- Ranking covers every open job ------------------------------------------
    jobs = cur.execute("""select w.id, w.wo_number, w.required_skill, w.status
                            from public.work_orders w
                           where w.status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS')
                           order by w.id""").fetchall()
    thin = []
    ranks = {}
    for wo_id, number, skill, status in jobs:
        res = rank(cur, wo_id)
        ranks[wo_id] = res
        available = len(res.get("available_ranked", []))
        if available < 2:
            thin.append((number, skill, available))
    check("W4 every open work order ranks at least two technicians", not thin, thin or [j[1] for j in jobs])

    top_ok = all(
        all(res["available_ranked"][i]["score"] >= res["available_ranked"][i + 1]["score"]
            for i in range(len(res["available_ranked"]) - 1))
        for res in ranks.values())
    check("W5 ranked order is score-descending", top_ok)

    # -- Auto-assign the whole queue --------------------------------------------
    pending = [j for j in jobs if j[3] == "PENDING_ASSIGNMENT"]
    assigned = []
    for wo_id, number, skill, _ in pending:
        as_user(cur, ADMIN_UUID)
        res = one(cur, "select public.rpc_assign_or_rebalance_staff(%s, null, %s, 'FACILITIES_ADMIN', true)",
                  (wo_id, ADMIN_EMAIL))[0]
        as_postgres(cur)
        assigned.append((number, skill, res.get("success"), res.get("assigned_staff_code")))
    check("W6 every pending job auto-assigns", pending and all(a[2] is True for a in assigned), assigned)

    skilled = cur.execute("""select count(*) from public.work_orders w
                               join public.staff_profiles sp on sp.staff_code = w.assigned_staff_code
                              where w.id = any(%s) and sp.primary_skill = w.required_skill""",
                          ([j[0] for j in pending],)).fetchone()[0]
    check("W7 every assignment matches the required skill", skilled == len(pending), (skilled, len(pending)))

    overloaded = one(cur, "select count(*) from public.staff_profiles"
                          " where staff_category = 'MAINTENANCE_TECH'"
                          "   and current_active_jobs > max_concurrent_jobs")[0]
    check("W8 capacity is never exceeded", overloaded == 0, overloaded)

    # -- Gates stay visible ------------------------------------------------------
    hvac_job = next((j for j in jobs if j[2] == "HVAC"), None)
    if hvac_job:
        res = ranks[hvac_job[0]]
        off = [u for u in res["unavailable_staff"] if u["staff_code"] == "MAINT-22"]
        check("W9 off-shift technician rejected with the exact gate",
              off and off[0]["failed_gate"] == "GATE_3_OFF_SHIFT", off)

    plumb = make_wo(cur, "WO-2026-9001", "PLUMBING")
    res = rank(cur, plumb)
    leave = [u for u in res["unavailable_staff"] if u["staff_code"] == "MAINT-27"]
    check("W10 on-leave technician rejected with the exact gate",
          leave and leave[0]["failed_gate"] == "GATE_3_ON_LEAVE", leave)

    cur.execute("update public.staff_profiles set current_active_jobs = max_concurrent_jobs"
                " where staff_code = 'MAINT-08'")
    res = rank(cur, plumb)
    full = [u for u in res["unavailable_staff"] if u["staff_code"] == "MAINT-08"]
    check("W11 capacity gate appears when a technician is full",
          full and full[0]["failed_gate"] == "GATE_4_CAPACITY", full)
    cur.execute("update public.staff_profiles set current_active_jobs = 0 where staff_code = 'MAINT-08'")

    hv = make_wo(cur, "WO-2026-9002", "ELECTRICAL", "HIGH_VOLTAGE")
    res = rank(cur, hv)
    standard = [u for u in res["unavailable_staff"] if u["staff_code"] == "MAINT-16"]
    cleared = [c for c in res["available_ranked"] if c["risk_clearance"] == "HIGH_VOLTAGE"]
    check("W12 high-voltage jobs demand high-voltage clearance",
          standard and standard[0]["failed_gate"] == "GATE_2_RISK_CLEARANCE" and len(cleared) >= 2,
          (standard, len(cleared)))

    # -- Summary RPC -------------------------------------------------------------
    as_user(cur, ADMIN_UUID)
    summary = one(cur, "select public.rpc_workforce_summary()")[0]
    as_postgres(cur)
    check("W13 workforce summary for admins", summary.get("success") is True
          and summary.get("total") == 30 and len(summary.get("by_skill", [])) >= 5,
          {k: summary.get(k) for k in ("total", "on_shift", "available")})
    as_user(cur, STUDENT_UUID)
    denied_summary = one(cur, "select public.rpc_workforce_summary()->>'error'")[0]
    denied_assign = one(cur, "select public.rpc_assign_or_rebalance_staff(%s, null,"
                             " 'student@nosih.edu.in', 'STUDENT', true)->>'error'", (pending[0][0],))[0]
    as_postgres(cur)
    check("W14 workforce summary and assignment denied to students",
          denied_summary == "FORBIDDEN" and denied_assign == "FORBIDDEN", (denied_summary, denied_assign))

    conn.rollback()
    print(f"\nRESULT: {'ALL PASS' if not failures else str(len(failures)) + ' FAILURE(S)'}")
    raise SystemExit(0 if not failures else 1)


if __name__ == "__main__":
    main()
