"""SLA system gate.

Four promises are checked here:

1. The matrix is the source of truth. Every priority carries a response and a
   resolution deadline, a category override wins over the general row, and a
   request is born with the deadlines its urgency earns.
2. The clock counts the time the campus was open. Weekends, academic holidays
   and semester breaks never count against a request, and a 24x7 service
   accrues the wall clock instead.
3. The engine keeps its word. The response clock stops at the first staff
   reply, half time is a milestone, 75% is a warning, 100% is a breach that
   escalates - and a breached critical request changes hands.
4. Staff can stop and restart a clock, a student cannot, and the read models
   that the complaint portal and the admin console read are honest.

Every mutation is rolled back at the end.
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402

STUDENT_UUID = "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
ADMIN_UUID = "4642ba88-5b19-458e-b9c0-84e70e04f060"
FACULTY_EMAIL = "fac001@nosih.edu.in"
ADMIN_EMAIL = "facilities@nosih.edu.in"
IST = timezone(timedelta(hours=5, minutes=30))

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def as_user(cur, uuid) -> None:
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": str(uuid), "role": "authenticated"}),))
    cur.execute("set role authenticated")


def as_postgres(cur) -> None:
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', '', false)")


def one(cur, sql: str, params: dict | None = None):
    """The first row of a statement, or None when it produced no records."""
    cur.execute(sql, params or {})
    if cur.description is None:
        return None
    rows = cur.fetchall()
    return rows[0] if rows else None


def many(cur, sql: str, params: dict | None = None):
    cur.execute(sql, params or {})
    if cur.description is None:
        return []
    return cur.fetchall()


def monday_at(offset_days: int, hour: str) -> str:
    """A local IST timestamp on a weekday of the current week."""
    return (f"((date_trunc('week', current_date)::date + {offset_days})::date + time '{hour}') "
            "at time zone 'Asia/Kolkata'")


def main() -> None:
    with connect() as conn:
        cur = conn.cursor()

        # ------------------------------------------------------------------
        # 1. The matrix
        # ------------------------------------------------------------------
        policy = one(cur, "select public.nosih_sla_policy_for('CRITICAL', null)")[0]
        check("M1 P1 carries the campus response and resolution deadlines",
              policy["priority_code"] == "P1" and policy["response_target_mins"] == 30
              and policy["resolution_target_mins"] == 240 and policy["is_24x7"] is True,
              (policy["priority_code"], policy["response_target_mins"], policy["resolution_target_mins"]))

        override = one(cur, "select public.nosih_sla_policy_for('CRITICAL', 'SAFETY_FIRE')")[0]
        check("M2 a category override wins over the general row",
              override["response_target_mins"] == 15 and override["resolution_target_mins"] == 120,
              (override["response_target_mins"], override["resolution_target_mins"]))

        low = one(cur, "select public.nosih_sla_policy_for('LOW', null)")[0]
        check("M3 a low request is answered in a day and delivered in five working days",
              low["priority_code"] == "P4" and low["response_target_mins"] == 1440
              and low["resolution_target_mins"] == 1800 and low["is_24x7"] is False,
              (low["priority_code"], low["response_target_mins"], low["resolution_target_mins"]))

        medium = one(cur, "select public.nosih_sla_policy_for('MEDIUM', null)")[0]
        check("M3b a standard request is answered in four working hours and delivered in two days",
              medium["priority_code"] == "P3" and medium["response_target_mins"] == 240
              and medium["resolution_target_mins"] == 2880 and medium["is_24x7"] is False,
              (medium["priority_code"], medium["response_target_mins"], medium["resolution_target_mins"]))

        as_user(cur, ADMIN_UUID)
        matrix = one(cur, "select public.rpc_sla_matrix()")[0]
        codes = sorted({row["priority_code"] for row in matrix["policies"]})
        check("M4 the matrix publishes every priority", codes == ["P1", "P2", "P3", "P4"], codes)
        check("M5 the matrix carries the academic calendar",
              any(row["is_working_day"] is False for row in matrix["calendar"])
              and any(row["is_working_day"] is True and row["open_minute"] == 480 for row in matrix["calendar"]),
              len(matrix["calendar"]))

        # ------------------------------------------------------------------
        # 2. The operating calendar
        # ------------------------------------------------------------------
        teaching_day = one(cur, f"select public.nosih_sla_working_minutes({monday_at(1, '09:00')}, {monday_at(1, '15:00')})")[0]
        check("C1 a teaching day counts 360 operational minutes", teaching_day == 360, teaching_day)

        weekend = one(cur, f"select public.nosih_sla_working_minutes({monday_at(5, '09:00')}, {monday_at(5, '15:00')})")[0]
        check("C2 a weekend counts nothing", weekend == 0, weekend)

        holiday = one(cur, f"select public.nosih_sla_working_minutes({monday_at(21, '09:00')}, {monday_at(21, '15:00')})")[0]
        check("C3 an academic holiday counts nothing", holiday == 0, holiday)

        after_hours = one(cur, f"select public.nosih_sla_working_minutes({monday_at(1, '16:00')}, {monday_at(1, '18:00')})")[0]
        check("C4 the hours outside the support window count nothing", after_hours == 0, after_hours)

        always_on = one(cur, f"select public.nosih_sla_operating_minutes({monday_at(5, '09:00')}, {monday_at(5, '15:00')}, true)")[0]
        check("C5 a 24x7 service accrues the wall clock", always_on == 360, always_on)

        across = one(cur, f"select public.nosih_sla_working_minutes({monday_at(4, '09:00')}, {monday_at(8, '15:00')})")[0]
        check("C6 the weekend is skipped but the teaching days are not", across == 1080, across)

        # ------------------------------------------------------------------
        # 3. A request is born with the matrix
        # ------------------------------------------------------------------
        as_user(cur, STUDENT_UUID)
        safety = one(cur, "select public.rpc_submit_complaint(cast(%(payload)s as jsonb))", {
            "payload": json.dumps({
                "email": "aids1a01@nosih.edu.in",
                "is_anonymous": False,
                "space_code": "B3-05",
                "description": "the socket is sparking and there is smoke near the switch board",
                "source_channel": "WEB_PORTAL",
            })})[0]
        check("T1 the request is accepted", safety.get("success") is True, safety.get("error"))
        safety_id = safety["complaint"]["id"]

        plain = one(cur, "select public.rpc_submit_complaint(cast(%(payload)s as jsonb))", {
            "payload": json.dumps({
                "email": "aids1a01@nosih.edu.in",
                "is_anonymous": False,
                "space_code": "B3-06",
                "description": "the room chair is broken and the door handle is loose",
                "source_channel": "WEB_PORTAL",
            })})[0]
        plain_id = plain["complaint"]["id"]

        as_postgres(cur)
        clocks = many(cur, """
            select c.ticket_number, c.category, s.priority_code, s.is_24x7,
                   s.response_target_mins, s.resolution_target_mins, c.urgency
              from public.sla_clocks s
              join public.work_orders w on w.id = s.target_id
              join public.complaints c on c.id = w.complaint_id
             where w.complaint_id = any(%(ids)s)
             order by s.id""", {"ids": [safety_id, plain_id]})
        critical = [row for row in clocks if row[1] == 'SAFETY_FIRE']
        standard = [row for row in clocks if row[1] != 'SAFETY_FIRE']
        check("T2 a safety request is born on the critical policy",
              len(critical) == 1 and critical[0][2] == 'P1' and critical[0][3] is True
              and critical[0][4] == 15 and critical[0][5] == 120,
              critical[0] if critical else None)
        # The verdict on urgency comes from the model, so the promise is checked
        # against the matrix: the clock carries the deadlines its own urgency
        # earns, whatever the model decided.
        earned = one(cur, "select public.nosih_sla_policy_for(%(u)s, %(c)s)",
                     {"u": standard[0][6], "c": standard[0][1]})[0] if standard else {}
        check("T3 a standard request is born on the policy its urgency earns",
              len(standard) == 1 and standard[0][2] == earned.get("priority_code")
              and standard[0][3] == earned.get("is_24x7")
              and standard[0][4] == earned.get("response_target_mins")
              and standard[0][5] == earned.get("resolution_target_mins")
              and standard[0][3] is False,
              standard[0] if standard else None)

        critical_clock = one(cur, """
            select s.id, s.target_id, w.assigned_staff_code
              from public.sla_clocks s join public.work_orders w on w.id = s.target_id
             where w.complaint_id = %(id)s""", {"id": safety_id})
        standard_clock = one(cur, """
            select s.id, s.target_id from public.sla_clocks s join public.work_orders w on w.id = s.target_id
             where w.complaint_id = %(id)s""", {"id": plain_id})

        # ------------------------------------------------------------------
        # 4. The clock only counts the time the campus was open
        # ------------------------------------------------------------------
        one(cur, """
            update public.sla_clocks
               set last_tick_at = now() - interval '120 minutes', elapsed_active_mins = 0,
                   response_elapsed_mins = 0, breach_state = 'HEALTHY', last_milestone = null,
                   current_escalation_tier = 1
             where id = any(%(ids)s)""", {"ids": [critical_clock[0], standard_clock[0]]})
        tick = one(cur, "select public.rpc_tick_sla_clocks()")[0]
        check("T4 the tick runs", tick.get("ticked", 0) >= 1, tick)

        elapsed = many(cur, """
            select s.id, s.is_24x7, s.elapsed_active_mins, s.response_elapsed_mins
              from public.sla_clocks s where s.id = any(%(ids)s)""",
                      {"ids": [critical_clock[0], standard_clock[0]]})
        by_id = {row[0]: row for row in elapsed}
        critical_row = by_id[critical_clock[0]]
        standard_row = by_id[standard_clock[0]]
        check("T5 a 24x7 clock accrues the wall clock",
              critical_row[2] >= 119 and critical_row[3] >= 119, critical_row[2:])
        check("T6 a working-hours clock does not run while the campus is closed",
              standard_row[2] == 0 and standard_row[3] == 0, standard_row[2:])

        # ------------------------------------------------------------------
        # 5. Milestones, escalation and the hand-over
        # ------------------------------------------------------------------
        one(cur, """
            update public.sla_clocks
               set elapsed_active_mins = 55, response_elapsed_mins = 4,
                   last_tick_at = now() - interval '10 minutes', breach_state = 'HEALTHY',
                   last_milestone = null, current_escalation_tier = 1
             where id = %(id)s""", {"id": critical_clock[0]})
        one(cur, "select public.rpc_tick_sla_clocks()")
        milestone = one(cur, """
            select last_milestone, breach_state from public.sla_clocks where id = %(id)s""",
                       {"id": critical_clock[0]})
        half_notified = one(cur, """
            select count(*) from public.notification_logs
             where payload_json like '%%SLA_HALF_ELAPSED%%'""")[0]
        check("T7 half the resolution time is a milestone", milestone[0] == 'HALF_ELAPSED', milestone)
        check("T8 the half-time milestone notifies the officer and the head of department",
              half_notified >= 1, half_notified)

        one(cur, """
            update public.sla_clocks
               set elapsed_active_mins = 85, last_tick_at = now() - interval '10 minutes',
                   breach_state = 'HEALTHY', last_milestone = 'HALF_ELAPSED'
             where id = %(id)s""", {"id": critical_clock[0]})
        one(cur, "select public.rpc_tick_sla_clocks()")
        warned = one(cur, """
            select breach_state, last_milestone from public.sla_clocks where id = %(id)s""",
                     {"id": critical_clock[0]})
        check("T9 three quarters of the deadline is a warning",
              warned[0] == 'WARNING_75' and warned[1] == 'WARNING_75', warned)

        officer_before = one(cur, "select assigned_staff_code from public.work_orders where id = %(id)s",
                             {"id": critical_clock[1]})[0]
        one(cur, """
            update public.sla_clocks
               set elapsed_active_mins = 115, last_tick_at = now() - interval '10 minutes',
                   breach_state = 'WARNING_75', last_milestone = 'WARNING_75',
                   current_escalation_tier = 1
             where id = %(id)s""", {"id": critical_clock[0]})
        one(cur, "select public.rpc_tick_sla_clocks()")
        breached = one(cur, """
            select breach_state, current_escalation_tier, escalated_at is not null
              from public.sla_clocks where id = %(id)s""", {"id": critical_clock[0]})
        breach_notified = one(cur, """
            select count(*) from public.notification_logs where payload_json like '%%SLA_BREACHED_100%%'""")[0]
        check("T10 the deadline breach escalates the tier", breached[0] == 'BREACHED_100' and breached[1] >= 2, breached)
        check("T11 the breach notifies the escalation chain", breach_notified >= 1, breach_notified)

        officer_after = one(cur, "select assigned_staff_code from public.work_orders where id = %(id)s",
                             {"id": critical_clock[1]})[0]
        reassigned = one(cur, """
            select count(*) from public.audit_logs
             where action = 'SLA_ESCALATION_REASSIGN' and outcome = 'ALLOWED'""")[0]
        check("T12 a breached critical request changes hands",
              officer_after not in (None, officer_before) and reassigned >= 1,
              (officer_before, officer_after, reassigned))

        # ------------------------------------------------------------------
        # 6. The response clock
        # ------------------------------------------------------------------
        as_postgres(cur)
        staff_id = one(cur, "select id from public.users where email = %(email)s", {"email": ADMIN_EMAIL})[0]
        one(cur, """
            insert into public.complaint_comments (complaint_id, body, is_anonymous, author_user_id,
                                                  public_author_label, author_role_badge, moderation_status, created_at)
            values (%(id)s, 'Acknowledged - the electrician is on the way.', false, %(staff)s,
                    'Facilities control room', 'FACILITIES', 'APPROVED', now())""",
            {"id": safety_id, "staff": staff_id})
        responded = one(cur, """
            select first_response_at is not null, response_breach_state, response_elapsed_mins
              from public.sla_clocks where id = %(id)s""", {"id": critical_clock[0]})
        check("T13 the first staff reply answers the request",
              responded[0] is True and responded[1] == 'MET', responded)

        # Asking the reporter for details stops the clock; the answer restarts it.
        one(cur, """
            update public.complaints
               set missing_info_questions_json = '["Which bench is affected?"]'
             where id = %(id)s""", {"id": plain_id})
        paused = one(cur, "select is_paused, pause_reason from public.sla_clocks where id = %(id)s",
                     {"id": standard_clock[0]})
        check("T14 asking the reporter for details pauses the clock",
              paused[0] is True and paused[1] == 'AWAITING_REPORTER', paused)

        as_user(cur, STUDENT_UUID)
        one(cur, "select public.rpc_supplement_complaint(%(id)s, %(answers)s)", {
            "id": plain_id,
            "answers": json.dumps({"which_bench": "Third bench near the window"})})
        as_postgres(cur)
        resumed = one(cur, "select is_paused, pause_reason from public.sla_clocks where id = %(id)s",
                      {"id": standard_clock[0]})
        check("T15 the answer restarts the clock",
              resumed[0] is False and resumed[1] is None, resumed)

        # ------------------------------------------------------------------
        # 7. Stopping and restarting a clock by hand
        # ------------------------------------------------------------------
        as_user(cur, ADMIN_UUID)
        paused = one(cur, "select public.rpc_sla_pause_clock(%(id)s, 'PARTS_UNAVAILABLE', %(email)s)",
                     {"id": critical_clock[1], "email": ADMIN_EMAIL})[0]
        check("P1 a staff member can pause a clock",
              paused.get("success") is True and paused.get("pause_reason") == 'PARTS_UNAVAILABLE', paused)

        invalid = one(cur, "select public.rpc_sla_pause_clock(%(id)s, 'BECAUSE', %(email)s)",
                      {"id": critical_clock[1], "email": ADMIN_EMAIL})[0]
        check("P2 an unknown pause reason is refused", invalid.get("error") == 'INVALID_REASON', invalid)

        as_user(cur, STUDENT_UUID)
        denied = one(cur, "select public.rpc_sla_pause_clock(%(id)s, 'PARTS_UNAVAILABLE', 'aids1a01@nosih.edu.in')",
                     {"id": critical_clock[1]})[0]
        check("P3 a student cannot pause a clock", denied.get("error") == 'FORBIDDEN', denied)

        as_user(cur, ADMIN_UUID)
        resumed = one(cur, "select public.rpc_sla_resume_clock(%(id)s, %(email)s)",
                      {"id": critical_clock[1], "email": ADMIN_EMAIL})[0]
        check("P4 a staff member can restart a clock",
              resumed.get("success") is True and resumed.get("is_paused") is False, resumed)

        as_postgres(cur)
        audited = one(cur, """
            select count(*) from public.audit_logs where action in ('SLA_PAUSE', 'SLA_RESUME')""")[0]
        check("P5 the pause and the restart are on the audit chain", audited >= 2, audited)

        # ------------------------------------------------------------------
        # 8. The read models
        # ------------------------------------------------------------------
        as_user(cur, ADMIN_UUID)
        board = one(cur, "select public.rpc_sla_board('ALL', 50)")[0]
        row = next((item for item in board["rows"] if item["work_order_id"] == critical_clock[1]), None)
        check("R1 the board carries the live clock with its deadlines",
              row is not None and row["priority_code"] == 'P1' and row["resolution_target_mins"] == 120
              and row["officer"] is not None and row["head_of_department"] is not None,
              (row or {}).get("work_order_number"))
        check("R2 the board summarises the campus",
              board["summary"]["total"] > 0 and "breached" in board["summary"], board["summary"])

        compliance = one(cur, "select public.rpc_sla_compliance(90)")[0]
        totals = compliance["totals"]
        check("R3 the compliance report counts every request in the window",
              totals["requests"] >= totals["closed"] and totals["closed"] == totals["met"] + totals["missed"],
              totals)
        check("R4 the compliance report scores every department",
              len(compliance["by_department"]) > 0
              and all("compliance_pct" in item for item in compliance["by_department"]),
              [item["department_code"] for item in compliance["by_department"]])
        check("R5 the compliance report splits by priority and by service",
              len(compliance["by_priority"]) > 0 and len(compliance["by_service"]) > 0,
              (compliance["by_priority"], compliance["by_service"]))

        as_user(cur, STUDENT_UUID)
        student_board = one(cur, "select public.rpc_sla_board('ALL', 10)")[0]
        student_report = one(cur, "select public.rpc_sla_compliance(90)")[0]
        check("R6 a student cannot read the SLA board or the compliance report",
              student_board.get("error") == "FORBIDDEN" and student_report.get("error") == "FORBIDDEN",
              (student_board.get("error"), student_report.get("error")))

        as_postgres(cur)
        snapshot = one(cur, "select public.nosih_sla_snapshot(%(id)s)", {"id": safety_id})[0]
        check("R7 the ticket snapshot carries both deadlines and the milestones",
              snapshot["available"] is True and snapshot["priority_code"] == 'P1'
              and snapshot["response_target_mins"] == 15 and snapshot["resolution_target_mins"] == 120
              and len(snapshot["milestones"]) == 4,
              (snapshot.get("priority_code"), snapshot.get("resolution_target_mins")))

        # ------------------------------------------------------------------
        # 9. The console follows the department scope
        # ------------------------------------------------------------------
        as_postgres(cur)
        hod = one(cur, """select auth_user_id, department_code from public.users
                           where email = 'hod.cse@nosih.edu.in' and is_active""")
        cse_spaces = {row[0] for row in many(cur, """
            select space_code from public.department_spaces where department_code = 'CSE'""")}
        in_scope = one(cur, """
            select r.code from public.rooms r
              join public.department_spaces ds on ds.space_code = r.code
             where ds.department_code = 'CSE' and r.visual_state = 'HEALTHY'
             order by r.code limit 1""")
        out_scope = one(cur, """
            select r.code from public.rooms r
              join public.department_spaces ds on ds.space_code = r.code
             where ds.department_code <> 'CSE' and r.visual_state = 'HEALTHY'
             order by r.code limit 1""")

        if not hod or not hod[0]:
            check("R8 a department manager account exists", False, hod)
            conn.rollback()
            print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
            sys.exit(0 if not failures else 1)

        as_user(cur, STUDENT_UUID)
        scoped_ids: list[int] = []
        for space, tag in ((in_scope[0], 'scope-in'), (out_scope[0], 'scope-out')):
            submitted = one(cur, "select public.rpc_submit_complaint(cast(%(payload)s as jsonb))", {
                "payload": json.dumps({
                    "email": "aids1a01@nosih.edu.in",
                    "is_anonymous": False,
                    "space_code": space,
                    "description": f"{tag}: the projector does not switch on and the socket smells of burning",
                    "source_channel": "WEB_PORTAL",
                })})[0]
            scoped_ids.append(submitted["complaint"]["id"])

        as_postgres(cur)
        scoped_clocks = many(cur, """
            select w.id, w.space_code from public.work_orders w
             where w.complaint_id = any(%(ids)s)""", {"ids": scoped_ids})
        inside = next(item[0] for item in scoped_clocks if item[1] == in_scope[0])
        outside = next(item[0] for item in scoped_clocks if item[1] == out_scope[0])

        as_user(cur, ADMIN_UUID)
        campus_board = one(cur, "select public.rpc_sla_board('ALL', 300)")[0]
        as_user(cur, hod[0])
        hod_board = one(cur, "select public.rpc_sla_board('ALL', 300)")[0]
        visible = {item["space_code"] for item in hod_board["rows"]}
        check("R8 a department manager reads only the clocks of their own department",
              hod_board.get("error") is None and visible <= cse_spaces
              and len(hod_board["rows"]) <= len(campus_board["rows"]),
              (sorted(visible - cse_spaces)[:4], len(hod_board["rows"]), len(campus_board["rows"])))

        as_user(cur, ADMIN_UUID)
        campus_report = one(cur, "select public.rpc_sla_compliance(90)")[0]
        as_user(cur, hod[0])
        hod_report = one(cur, "select public.rpc_sla_compliance(90)")[0]
        report_departments = [item["department_code"] for item in hod_report.get("by_department", [])]
        # A space can belong to two departments, so a shared space is reported
        # under the first of them. The rule is simple: every department in the
        # report must own at least one space the manager also owns.
        foreign = []
        for code in report_departments:
            overlap = one(cur, """
                select exists (select 1 from public.department_spaces ds
                                where ds.department_code = %(code)s
                                  and ds.space_code = any(%(spaces)s))""",
                {"code": code, "spaces": list(cse_spaces)})[0]
            if not overlap:
                foreign.append(code)
        check("R9 the compliance report is scoped to the department too",
              hod_report.get("error") is None and not foreign
              and hod_report["totals"]["requests"] <= campus_report["totals"]["requests"],
              foreign or (report_departments, hod_report["totals"]["requests"],
                          campus_report["totals"]["requests"]))

        blocked = one(cur, "select public.rpc_sla_pause_clock(%(id)s, 'PARTS_UNAVAILABLE', 'hod.cse@nosih.edu.in')",
                      {"id": outside})[0]
        check("R10 a department manager cannot stop a clock in another department",
              blocked.get("error") == 'FORBIDDEN_DEPARTMENT_SCOPE', blocked)

        allowed = one(cur, "select public.rpc_sla_pause_clock(%(id)s, 'PARTS_UNAVAILABLE', 'hod.cse@nosih.edu.in')",
                      {"id": inside})[0]
        check("R11 a department manager can stop a clock in their own department",
              allowed.get("success") is True, allowed)

        conn.rollback()

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
