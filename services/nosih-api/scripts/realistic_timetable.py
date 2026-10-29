"""Rebuild the timetable so it reads like a real college week.

- 20 faculty per department (15 existing + 5 new), each owning one theory subject.
- Every class studies a rotating subject each period; the subject's teacher is
  never double-booked in the same day/period.
- Every lab session gets a lab-staff demonstrator and a distinct assistant.
- Rooms and periods are left untouched, so the CP-SAT room plan stays valid.
"""
from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

DAYS = ["MON", "TUE", "WED", "THU", "FRI"]

SUBJECTS = {
    "CSE": ["Data Structures", "Database Systems", "Operating Systems", "Computer Networks", "Theory of Computation"],
    "AIML": ["Machine Learning", "Deep Learning", "Data Mining", "Natural Language Processing", "Reinforcement Learning"],
    "AIDS": ["Probability & Statistics", "Data Visualisation", "Big Data Systems", "Time Series Analysis", "AI Ethics"],
    "CYBER": ["Cryptography", "Network Security", "Digital Forensics", "Ethical Hacking", "Secure Software Design"],
    "ECE": ["Digital Electronics", "Signals & Systems", "VLSI Design", "Microcontrollers", "Communication Systems"],
    "MECH": ["Thermodynamics", "Fluid Mechanics", "Machine Design", "Manufacturing Processes", "Heat Transfer"],
}
LABS = {
    "CSE": ["Data Structures Lab", "DBMS Lab", "Operating Systems Lab", "Networks Lab"],
    "AIML": ["ML Lab", "Deep Learning Lab", "Data Mining Lab", "NLP Lab"],
    "AIDS": ["Statistics Lab", "Visualisation Lab", "Big Data Lab", "Time Series Lab"],
    "CYBER": ["Cryptography Lab", "Forensics Lab", "Security Lab", "Secure Coding Lab"],
    "ECE": ["Electronics Lab", "VLSI Lab", "Embedded Lab", "Communication Lab"],
    "MECH": ["Thermal Lab", "Fluid Lab", "CAD Lab", "Manufacturing Lab"],
}
NEW_NAMES = [
    "Ananya Iyer", "Rohit Sharma", "Meera Krishnan", "Vikram Rao", "Sneha Patel",
    "Arjun Nair", "Divya Menon", "Karthik Reddy", "Pooja Desai", "Rahul Verma",
    "Lakshmi Narayan", "Aditya Bose", "Nandini Gupta", "Siddharth Pillai", "Kavya Srinivasan",
    "Manish Joshi", "Ritika Chauhan", "Suresh Babu", "Deepa Ramesh", "Harish Kulkarni",
    "Ishita Sen", "Naveen Kumar", "Aparna Das", "Gaurav Malhotra", "Shruti Bhandari",
    "Prakash Mehta", "Vaishnavi Subramanian", "Tanmay Ghosh", "Neha Agarwal", "Vivek Shetty",
]


def slug(title: str, dept: str) -> str:
    letters = "".join(part[0] for part in title.replace("&", "").split() if part[:1].isalpha())
    return f"{dept}-{letters.upper()[:4]}"


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            # 1. Top each department up to 20 faculty (12.5% slack over its 15 classes).
            cur.execute("""select u.department_code, count(*)
                             from public.staff_profiles sp join public.users u on u.id = sp.user_id
                            where sp.staff_category = 'CLASS_FACULTY'
                            group by 1""")
            counts = dict(cur.fetchall())
            cur.execute("select max((regexp_match(staff_code, '([0-9]+)$'))[1]::int) from public.staff_profiles where staff_category = 'CLASS_FACULTY'")
            next_code = (cur.fetchone()[0] or 90) + 1
            depts = sorted(counts)
            added = 0
            for name in NEW_NAMES:
                dept = depts[added % len(depts)]
                if counts.get(dept, 0) >= 20:
                    continue
                code = f"FAC-{next_code:03d}"
                email = f"fac{next_code:03d}@nosih.edu.in"
                cur.execute(
                    "insert into public.users (email, full_name, role, department_code, is_active) values (%s, %s, 'FACULTY', %s, true) on conflict (email) do nothing returning id",
                    (email, name, dept),
                )
                row = cur.fetchone()
                next_code += 1
                if row is None:
                    continue
                cur.execute(
                    """insert into public.staff_profiles
                         (user_id, staff_code, staff_category, primary_skill, skill_proficiency,
                          risk_clearance, hourly_cost_inr, is_on_shift, is_on_leave,
                          current_active_jobs, max_concurrent_jobs, current_block_location)
                       values (%s, %s, 'CLASS_FACULTY', null, 3, 'STANDARD', 0, true, false, 0, 3, %s)
                       on conflict (staff_code) do nothing""",
                    (row[0], code, dept[0]),
                )
                counts[dept] = counts.get(dept, 0) + 1
                added += 1
            print(f"faculty added: {added}")

            # 2. Load faculty pools and classes.
            cur.execute("""select sp.staff_code, u.department_code
                             from public.staff_profiles sp join public.users u on u.id = sp.user_id
                            where sp.staff_category = 'CLASS_FACULTY' and u.is_active
                            order by sp.staff_code""")
            faculty = defaultdict(list)
            for code, dept in cur.fetchall():
                faculty[dept].append(code)

            cur.execute("select class_code, department_id from public.student_classes")
            dept_of = _department_map(cur)
            cur.execute("select class_code from public.student_classes order by class_code")
            classes = defaultdict(list)
            for (code,) in cur.fetchall():
                classes[dept_of[code]].append(code)

            # Subject ownership: four teachers per subject inside each department.
            owners = {}
            for dept, pool in faculty.items():
                for index, code in enumerate(pool):
                    owners.setdefault(dept, {}).setdefault(index % 5, []).append(code)

            cur.execute("select staff_code from public.staff_profiles where staff_category = 'LAB_STAFF' order by staff_code")
            lab_pool = [row[0] for row in cur.fetchall()]

            # 3. Assign every slot.
            cur.execute("select id, day_of_week, period_number, class_code, session_type from public.timetable_slots")
            slots = cur.fetchall()

            updates = []
            used_theory: dict[tuple[str, int], set[str]] = defaultdict(set)
            used_lab: dict[tuple[str, int], set[str]] = defaultdict(set)
            for slot_id, day, period, class_code, session_type in sorted(
                slots, key=lambda row: (DAYS.index(row[1]), row[2], row[3])
            ):
                dept = dept_of[class_code]
                day_index = DAYS.index(day)
                key = (day, period)
                if session_type == "LAB":
                    subject = LABS[dept][day_index % len(LABS[dept])]
                    used = used_lab[key]
                    available = [code for code in lab_pool if code not in used]
                    demo = available[0]
                    assist = available[1] if len(available) > 1 else None
                    used.add(demo)
                    if assist:
                        used.add(assist)
                    updates.append((slug(subject, dept), subject, demo, assist, slot_id))
                else:
                    section_index = classes[dept].index(class_code)
                    subject_index = (period - 1 + day_index + section_index) % 5
                    subject = SUBJECTS[dept][subject_index]
                    used = used_theory[key]
                    pool = owners[dept][subject_index]
                    # A section keeps the same subject teacher all week; the
                    # section offset guarantees distinct owners per period.
                    pick = pool[section_index % len(pool)]
                    if pick in used:
                        pick = next((code for code in pool if code not in used), None)
                    if pick is None:
                        pick = next((code for code in faculty[dept] if code not in used), None)
                    if pick is None:
                        pick = next((code for pool_codes in faculty.values() for code in pool_codes if code not in used), None)
                    used.add(pick)
                    updates.append((slug(subject, dept), subject, pick, None, slot_id))

            cur.executemany(
                """update public.timetable_slots
                      set subject_code = %s, subject_title = %s,
                          faculty_staff_code = %s, assisting_lab_staff_code = %s
                    where id = %s""",
                updates,
            )
            print(f"slots updated: {len(updates)}")

            # 4. Verification.
            cur.execute("""select count(*) from (
                             select day_of_week, period_number, faculty_staff_code
                               from public.timetable_slots
                              group by 1,2,3 having count(*) > 1) c""")
            print("staff collisions:", cur.fetchone()[0])

            cur.execute("""select min(distinct_faculty), max(distinct_faculty), min(labs), max(labs) from (
                             select class_code, count(distinct faculty_staff_code) as distinct_faculty,
                                    count(*) filter (where session_type = 'LAB') as labs
                               from public.timetable_slots group by 1) s""")
            print("faculty per class (min,max) / labs per week (min,max):", cur.fetchone())

            cur.execute("""select round(avg(load), 2) from (
                             select faculty_staff_code, count(*) as load
                               from public.timetable_slots where session_type = 'THEORY'
                              group by 1) s""")
            print("average theory periods per faculty per week:", cur.fetchone()[0])

        conn.commit()

    print("timetable realism applied")


def _class_codes(cur) -> list[str]:
    cur.execute("select class_code from public.student_classes")
    return [row[0] for row in cur.fetchall()]


def _department_map(cur) -> dict[str, str]:
    cur.execute("""select sc.class_code, coalesce(d.code, split_part(sc.class_code, '-', 1))
                     from public.student_classes sc
                     left join public.departments d on d.id = sc.department_id""")
    return {code: dept for code, dept in cur.fetchall()}


if __name__ == "__main__":
    main()
