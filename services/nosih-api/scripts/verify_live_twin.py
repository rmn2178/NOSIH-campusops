"""Prove the twin shifts with the campus clock: occupied spaces at P3 vs P4."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import resilient_connect as connect  # noqa: E402

failures: list[str] = []


def check(label: str, condition: bool, detail: object = "") -> None:
    print(("PASS  " if condition else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not condition:
        failures.append(label)


def snapshot(cur, period: int) -> tuple[str, int, list[str]]:
    cur.execute("update public.campus_clock_state set active_day = 'MON', active_period = %s, clock_mode = 'MANUAL' where id = 1", (period,))
    cur.execute(
        """select md5(string_agg(x->>'code', ',' order by x->>'code')),
                  count(*) filter (where (x->>'is_occupied_now')::boolean),
                  array_agg(x->>'code' order by x->>'code') filter (where (x->>'is_occupied_now')::boolean)
             from jsonb_array_elements(public.rpc_twin_overview()) x"""
    )
    fingerprint, occupied, codes = cur.fetchone()
    return fingerprint, occupied, codes or []


def main() -> None:
    with connect(autocommit=True) as conn:
        with conn.cursor() as cur:
            p3_hash, p3_count, p3_codes = snapshot(cur, 3)
            p4_hash, p4_count, p4_codes = snapshot(cur, 4)

            check("period 3 has occupied spaces", p3_count > 0, p3_count)
            check("period 4 has occupied spaces", p4_count > 0, p4_count)
            check("occupancy differs between P3 and P4", set(p3_codes) != set(p4_codes),
                  f"{len(set(p3_codes) ^ set(p4_codes))} spaces moved")

            cur.execute("""select ts.period_number, ts.session_type, ts.effective_space_code,
                                  ts.subject_title, ts.faculty_staff_code
                             from public.timetable_slots ts
                            where ts.class_code = 'CSE-Y2-B' and ts.day_of_week = 'MON'
                            order by ts.period_number""")
            rows = cur.fetchall()
            rooms = [row[2] for row in rows]
            teachers = [row[4] for row in rows]
            check("a class changes room during the day", len(set(rooms)) > 1, rooms)
            check("a class is taught by several teachers", len(set(teachers)) > 1, teachers)
            print("\nMON day for CSE-Y2-B:")
            for period, kind, room, subject, teacher in rows:
                print(f"  P{period}  {kind:6} {room:16} {subject[:32]:34} {teacher}")

            cur.execute("update public.campus_clock_state set clock_mode = 'LIVE' where id = 1")
            cur.execute("select public.nosih_clock_sync()")
            cur.execute("select active_day, active_period, clock_mode from public.campus_clock_state")
            print("\nclock returned to live:", cur.fetchone())

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
