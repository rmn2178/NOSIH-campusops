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
         "Nikhil","Tanvi","Yash","Shreya","Dev","Aisha","Harsh","Neha","Vikram","Priya",
         "Aryan","Sneha","Ritesh","Divya","Kunal","Lakshmi","Mohan","Rekha","Sanjay","Nandini",
         "Pranav","Ritika","Sameer","Aparna","Tarun","Ashwin","Bhavna","Chirag","Deepa","Eshan",
         "Farah","Gaurav","Harini","Imran","Jaya","Kamal","Leela","Madhav","Naina","Omkar",
         "Pallavi","Qadir","Rhea","Sarthak","Tejas","Uma","Varun","Wamika","Yashika","Zoya",
         "Aarohi","Bhavesh","Charu","Dhruv","Esha","Faisal","Girish","Hema","Inder","Jatin",
         "Kiran","Lavanya","Mihir","Naveen","Ojas","Preeti","Rakesh","Sonal","Tushar","Uday",
         "Vidya","Yuvraj","Zara","Abhay","Bhoomi","Chaitanya","Daksh","Ekta","Falguni","Gauri"]
LAST = ["Sharma","Iyer","Menon","Reddy","Patel","Nair","Gupta","Bose","Kulkarni","Das",
        "Joshi","Pillai","Verma","Rao","Sen","Mehta","Bhat","Chauhan","Ghosh","Shetty",
        "Kapoor","Malhotra","Sinha","Desai","Krishnan","Subramanian","Agarwal","Bhandari","Naidu","Mishra",
        "Chawla","Dutta","Eapen","Fernandes","Gandhi","Hegde","Iyengar","Jain","Khanna","Lal",
        "Mahajan","Narayan","Oberoi","Pandey","Qureshi","Raghavan","Saxena","Thakur","Upadhyay","Vaidya",
        "Wagh","Yadav","Zaveri","Acharya","Balan","Chandra","Dhar","Engineer","Fadnavis","Gokhale",
        "Hari","Irani","Jha","Kamath","Lalwani","Merchant","Nadkarni","Oommen","Prasad","Quraishi",
        "Ramachandran","Sastry","Trivedi","Unni","Varma","Wagle","Yagnik","Zutshi","Anand","Banerjee",
        "Chakraborty","Dalal","De","Ghosal","Hussain","Inamdar","Jagtap","Kaur","Lodha","Mathur",
        "Nayak","Ogale","Puri","Rawat","Sahu","Tandon","Uppal","Venkatesh","Walia","Yohannan"]
MID_STUDENT = ["A","B","C","D","E","F"]
MID_FACULTY = ["V","S","R","K"]
MID_LAB = ["G","H","J","L"]


def name_for(index: int, mids: list[str]) -> str:
    # 100 first x 100 last names => 10,000 unique pairs for 5,175 students.
    first = FIRST[index % len(FIRST)]
    last = LAST[(index // len(FIRST)) % len(LAST)]
    return f"{first} {last}"


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

            for role, mids, offset in (("FACULTY", MID_FACULTY, 7000), ("LAB_STAFF", MID_LAB, 9000)):
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
