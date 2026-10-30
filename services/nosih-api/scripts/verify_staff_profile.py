"""F9 staff-profile gate: every technician has a full record reconciling jobs.

Runs in a transaction and rolls back. Prints ALL PASS.
"""

import json

from _db import connect

ADMIN_UUID = "4642ba88-5b19-458e-b9c0-84e70e04f060"
STUDENT_UUID = "00000000-0000-0000-0000-000000000099"


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


def main():
    conn = connect()
    cur = conn.cursor()

    # -- Roster ---------------------------------------------------------------
    as_user(cur, ADMIN_UUID)
    summary = one(cur, "select public.rpc_workforce_summary()")[0]
    as_postgres(cur)
    staff = summary.get("staff") or []
    check("R1 roster lists all thirty technicians with identity and load",
          len(staff) == 30 and all(s.get("staff_code") and s.get("full_name")
                                   and s.get("primary_skill") for s in staff),
          len(staff))

    # -- Reconciling profile ---------------------------------------------------
    code = staff[0]["staff_code"]
    as_user(cur, ADMIN_UUID)
    profile = one(cur, "select public.rpc_get_staff_profile(%s)", (code,))[0]
    as_postgres(cur)
    check("R2 profile returns identity, shift and clearance",
          profile.get("full_name") and profile.get("email") and profile.get("shift_code")
          and profile.get("risk_clearance") and profile.get("staff_code") == code,
          profile.get("full_name"))

    db = one(cur, """select
          (select count(*) from public.work_orders where assigned_staff_code = %s),
          (select count(*) from public.work_orders where assigned_staff_code = %s
            and status in ('PENDING_ASSIGNMENT', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED_PARTS')),
          (select count(*) from public.work_orders where assigned_staff_code = %s
            and status in ('COMPLETED', 'CLOSED')),
          (select count(*) from public.maintenance_history where technician_code = %s),
          (select coalesce(sum(total_cost_inr), 0) from public.maintenance_history where technician_code = %s)""",
        (code, code, code, code, code))
    stats = profile["stats"]
    check("R3 profile stats reconcile with the live database",
          (stats["jobs_total"], stats["jobs_open"], stats["jobs_completed"],
           stats["repairs_count"], float(stats["repair_cost_inr"])) ==
          (db[0], db[1], db[2], db[3], float(db[4])), (stats, db))
    check("R4 job list is capped and carries work-order numbers",
          len(profile["jobs"]) == min(20, stats["jobs_total"])
          and all(j.get("wo_number") and j.get("space_code") for j in profile["jobs"]),
          len(profile["jobs"]))
    check("R5 repair list is capped and priced",
          len(profile["repairs"]) == min(10, stats["repairs_count"])
          and all("total_cost_inr" in r and "asset_code" in r for r in profile["repairs"]),
          len(profile["repairs"]))

    busiest = one(cur, """select technician_code, count(*) from public.maintenance_history
                           group by 1 order by 2 desc limit 1""")
    if busiest:
        as_user(cur, ADMIN_UUID)
        busy_profile = one(cur, "select public.rpc_get_staff_profile(%s)", (busiest[0],))[0]
        as_postgres(cur)
        check("R6 a working technician shows their priced repair history",
              busy_profile.get("repairs") and float(busy_profile["repairs"][0].get("total_cost_inr") or 0) >= 0
              and busy_profile.get("jobs"), (busiest[0], len(busy_profile.get("repairs", []))))

    as_user(cur, ADMIN_UUID)
    missing = one(cur, "select public.rpc_get_staff_profile('NO-SUCH-STAFF')->>'error'")[0]
    as_postgres(cur)
    check("R7 unknown staff code rejected", missing == "STAFF_NOT_FOUND", missing)

    as_user(cur, STUDENT_UUID)
    denied_profile = one(cur, "select public.rpc_get_staff_profile(%s)->>'error'", (code,))[0]
    denied_roster = one(cur, "select public.rpc_workforce_summary()->>'error'")[0]
    as_postgres(cur)
    check("R8 students cannot read staff profiles", denied_profile == "FORBIDDEN" and denied_roster == "FORBIDDEN",
          (denied_profile, denied_roster))

    conn.rollback()
    print(f"\nRESULT: {'ALL PASS' if not failures else str(len(failures)) + ' FAILURE(S)'}")
    raise SystemExit(0 if not failures else 1)


if __name__ == "__main__":
    main()
