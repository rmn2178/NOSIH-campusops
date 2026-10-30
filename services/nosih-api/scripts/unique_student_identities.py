"""Give every student a unique identity: code, department, class, unique name.
Also gives faculty and lab staff unique display names. Idempotent."""
from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

FIRST = ["Aarav","Ananya","Rohan","Diya","Kabir","Isha","Arjun","Meera","Vivaan","Sara",
         "Aditya","Riya","Karthik","Nisha","Rahul","Pooja","Siddharth","Kavya","Manav","Anika",
         "Nikhil","Tanvi","Yash","Shreya","Dev","Aisha","Harsh","Neha","Vikram","Priya"]
LAST = ["Sharma","Iyer","Menon","Reddy","Patel","Nair","Gupta","Bose","Kulkarni","Das",
        "Joshi","Pillai","Verma","Rao","Sen","Mehta","Bhat","Chauhan","Ghosh","Shetty",
        "Kapoor","Malhotra","Sinha","Desai","Krishnan","Subramanian","Agarwal","Bhandari","Naidu","Mishra"]
MID_STUDENT = ["A","B","C","D","E","F"]
MID_FACULTY = ["V","S","R","K"]
MID_LAB = ["G","H","J","L"]


def name_for(index: int, mids: list[str]) -> str:
    first = FIRST[index % len(FIRST)]
    mid = mids[(index // len(FIRST)) % len(mids)]
    last = LAST[(index // (len(FIRST) * len(mids))) % len(LAST)]
    return f"{first} {mid}. {last}"


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute("alter table public.users add column if not exists student_code text")
            cur.execute("create unique index if not exists users_student_code_key on public.users (student_code) where student_code is not null")

            cur.execute("""select sc.class_code, split_part(sc.class_code, '-', 1), sc.year_number, sc.section_letter
                             from public.student_classes sc order by sc.class_code""")
            classes = cur.fetchall()

            cur.execute("select id from public.users where role = 'STUDENT' order by email")
            students = [row[0] for row in cur.fetchall()]

            per_class: dict[str, int] = {}
            updates = []
            for i, uid in enumerate(students):
                class_code, dept, _year, _section = classes[i % len(classes)]
                per_class[class_code] = per_class.get(class_code, 0) + 1
                code = f"STU-{class_code}-{per_class[class_code]:03d}"
                updates.append((name_for(i, MID_STUDENT), dept, class_code, code, uid))

            cur.executemany("update public.users set full_name = %s, department_code = %s, class_code = %s, student_code = %s where id = %s", updates)
            print(f"students updated: {len(updates)}")

            for role, mids, offset in (("FACULTY", MID_FACULTY, 0), ("LAB_STAFF", MID_LAB, 0)):
                cur.execute("select id from public.users where role = %s order by email", (role,))
                rows = [row[0] for row in cur.fetchall()]
                cur.executemany(
                    "update public.users set full_name = %s where id = %s",
                    [(name_for(i + offset, mids), uid) for i, uid in enumerate(rows)],
                )
                print(f"{role.lower()} renamed: {len(rows)}")

        conn.commit()

    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute("""select role, count(*), count(distinct full_name) names,
                                  count(distinct student_code) codes, count(*) filter (where student_code is null) missing_code
                             from public.users group by 1 order by 1""")
            for row in cur.fetchall():
                print(row)
            cur.execute("select student_code, full_name, department_code, class_code from public.users where role = 'STUDENT' order by student_code limit 3")
            for row in cur.fetchall():
                print(row)


if __name__ == "__main__":
    main()
