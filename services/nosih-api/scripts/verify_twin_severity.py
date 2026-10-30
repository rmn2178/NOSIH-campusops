"""F8 twin-severity gate: manageable faults glow orange, major faults red.

Everything runs in one transaction and rolls back. Prints ALL PASS.
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


def submit(cur, space, description):
    res = one(cur, "select public.rpc_submit_complaint(%s)",
              (json.dumps({"email": "student@nosih.edu.in", "space_code": space,
                           "description": description, "source_channel": "WEB_PORTAL"}),))[0]
    assert res.get("success") is True, res
    cid = res["complaint"]["id"]
    ticket = res["complaint"]["ticket_number"]
    row = one(cur, "select category, urgency, status, moderation_status, ai_extracted_json from public.complaints where id = %s", (cid,))
    return cid, ticket, row


def room_state(cur, code):
    return one(cur, "select visual_state from public.rooms where code = %s", (code,))[0]


def main():
    conn = connect()
    cur = conn.cursor()

    # -- Criticality map -------------------------------------------------------
    row = one(cur, """select
        (select criticality from public.assets where asset_type = 'SMART_BOARD' limit 1),
        (select criticality from public.assets where asset_type = 'CEILING_FAN' limit 1),
        (select criticality from public.assets where asset_type = 'CANTEEN_APPLIANCE' limit 1),
        (select criticality from public.assets where asset_type = 'LAB_WORKSTATION' limit 1)""")
    check("S1 asset criticality map", row == ("CRITICAL", "STANDARD", "CRITICAL", "CRITICAL"), row)

    rooms = [r[0] for r in cur.execute(
        "select code from public.rooms where visual_state = 'HEALTHY' order by code limit 4").fetchall()]
    check("S2 four healthy rooms available for the test", len(rooms) == 4, rooms)
    fan_room, board_room, safety_room, mixed_room = rooms

    # -- A fan-only complaint stays manageable (light orange) --------------------
    cid, ticket, (category, urgency, status, moderation, extracted) = submit(
        cur, fan_room, "the ceiling fan is not working at all and the room is stuffy during the lecture")
    assets = json.loads(extracted)["target_assets"] if extracted else []
    critical_types = cur.execute(
        """select count(*) from public.assets where asset_code = any(%s) and criticality = 'CRITICAL'""",
        ([a.get("asset_code") for a in assets if a.get("asset_code")],)).fetchone()[0]
    check("S3 fan complaint classified FANS_HVAC with only manageable targets",
          category == "FANS_HVAC" and len(assets) > 0 and critical_types == 0,
          (category, len(assets), critical_types))
    check("S4 fan complaint never paints the room major", room_state(cur, fan_room) == "DEGRADED",
          room_state(cur, fan_room))

    # -- A smart board complaint is major (red) ----------------------------------
    cid_board, ticket_board, (category_b, urgency_b, status_b, mod_b, _) = submit(
        cur, board_room, "the smart board is dead and will not switch on for the lecture")
    check("S5 smart board complaint is IT_SMARTBOARD and HIGH urgency",
          category_b == "IT_SMARTBOARD" and urgency_b == "HIGH", (category_b, urgency_b))
    check("S6 smart board complaint paints the room major",
          mod_b != "APPROVED" or room_state(cur, board_room) == "FAULTY",
          (mod_b, room_state(cur, board_room)))

    # -- Safety wording overrides everything -------------------------------------
    cid_safe, ticket_safe, (category_s, urgency_s, status_s, mod_s, _) = submit(
        cur, safety_room, "there are sparks and a burning smell from the socket during the lecture")
    check("S7 safety wording escalates to SAFETY_FIRE / CRITICAL",
          category_s == "SAFETY_FIRE" and urgency_s == "CRITICAL", (category_s, urgency_s))
    check("S8 safety complaint paints the room major",
          mod_s != "APPROVED" or room_state(cur, safety_room) == "FAULTY",
          (mod_s, room_state(cur, safety_room)))

    # -- Severity follows materiality when complaints mix ------------------------
    submit(cur, mixed_room, "one ceiling fan is making a rattling noise in the back row")
    check("S9 mixing a manageable fan first keeps the room manageable",
          room_state(cur, mixed_room) == "DEGRADED", room_state(cur, mixed_room))
    cid_mix_board, _, _ = submit(cur, mixed_room, "the projector screen is black and will not turn on")
    check("S10 adding a smart board escalates the same room to major",
          room_state(cur, mixed_room) == "FAULTY", room_state(cur, mixed_room))
    as_user(cur, ADMIN_UUID)
    one(cur, "select public.rpc_update_complaint_status(%s, 'RESOLVED', %s)", (cid_mix_board, ADMIN_EMAIL))
    as_postgres(cur)
    check("S11 resolving the major drops the room back to manageable, not healthy",
          room_state(cur, mixed_room) == "DEGRADED", room_state(cur, mixed_room))
    one(cur, "select public.rpc_update_complaint_status(%s, 'RESOLVED', %s)", (cid, ADMIN_EMAIL))
    check("S12 resolving every fan complaint returns the room to healthy",
          room_state(cur, fan_room) == "HEALTHY", room_state(cur, fan_room))

    # -- Pulse injections follow the same rubric --------------------------------
    cur.execute("update public.simulation_config set max_open_simulated = 10")
    for table in ("canteens", "labs", "bill_bots"):
        cur.execute(f"update public.{table} set visual_state = 'MASKED' where visual_state = 'HEALTHY'")
    pulses = []
    for _ in range(8):
        res = one(cur, "select public.nosih_pulse_inject()")[0]
        if res.get("fired") is True:
            pulses.append(res)
        if any(r.get("asset_code", "").startswith("FAN-") for r in pulses):
            break
    for table in ("canteens", "labs", "rooms", "bill_bots"):
        cur.execute(f"update public.{table} set visual_state = 'HEALTHY' where visual_state = 'MASKED'")
    fan_pulses = [r for r in pulses if r.get("asset_code", "").startswith("FAN-")]
    check("S13 pulse reached a fan fault", bool(fan_pulses), [(r.get("asset_code"), r.get("space_code")) for r in pulses])
    if fan_pulses:
        room = fan_pulses[0]["space_code"]
        check("S14 pulse fan fault stays manageable", room_state(cur, room) == "DEGRADED",
              (room, room_state(cur, room)))
    mismatched = []
    for r in pulses:
        state = room_state(cur, r["space_code"])
        critical = one(cur, "select public.nosih_asset_type_criticality(%s)",
                       (one(cur, "select asset_type from public.assets where asset_code = %s", (r["asset_code"],))[0],))[0]
        expected = "FAULTY" if critical == "CRITICAL" else "DEGRADED"
        if state != expected:
            mismatched.append((r["asset_code"], state, expected))
    check("S15 every pulse injection colours by asset criticality", not mismatched, mismatched)

    # -- RBAC ---------------------------------------------------------------------
    as_user(cur, STUDENT_UUID)
    denied = one(cur, "select public.rpc_update_complaint_status(%s, 'RESOLVED', 'student@nosih.edu.in')->>'error'", (cid,))[0]
    as_postgres(cur)
    check("S16 students cannot resolve complaints", denied == "FORBIDDEN", denied)

    conn.rollback()
    print(f"\nRESULT: {'ALL PASS' if not failures else str(len(failures)) + ' FAILURE(S)'}")
    raise SystemExit(0 if not failures else 1)


if __name__ == "__main__":
    main()
