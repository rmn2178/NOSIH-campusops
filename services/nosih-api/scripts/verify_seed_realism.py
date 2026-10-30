"""F4 seed-realism gate: staff surname diversity + maintenance history freshness.

Read-only. Prints ALL PASS when the live project satisfies every rule.
"""

from _db import connect


def main() -> None:
    checks: list[tuple[str, bool, str]] = []
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """select role, count(distinct surname), max(c)
                     from (select u.role, split_part(u.full_name, ' ', -1) as surname, count(*) as c
                             from public.users u
                            where u.role in ('FACULTY', 'LAB_STAFF')
                            group by 1, 2) t
                    group by role"""
            )
            rows = dict((r[0], (r[1], r[2])) for r in cur.fetchall())
            for role, floor, ceiling in (("FACULTY", 30, 6), ("LAB_STAFF", 30, 4)):
                distinct, worst = rows.get(role, (0, 0))
                checks.append((
                    f"{role}: {distinct} distinct surnames, worst repeat {worst}",
                    distinct >= floor and worst <= ceiling,
                    f"expected >= {floor} surnames and worst repeat <= {ceiling}",
                ))

            cur.execute(
                """select count(*),
                          extract(epoch from now() - max(completed_at)) / 3600,
                          extract(epoch from now() - min(completed_at)) / 86400
                     from public.maintenance_history"""
            )
            total, hours_since_newest, days_since_oldest = cur.fetchone()
            checks.append((
                f"maintenance_history: {total} rows, newest {hours_since_newest:.1f}h ago, oldest {days_since_oldest:.1f}d ago",
                total >= 50 and hours_since_newest <= 168 and days_since_oldest <= 91,
                "expected >= 50 rows, newest within 7 days, oldest within 91 days",
            ))
    ok = all(passed for _, passed, _ in checks)
    for label, passed, rule in checks:
        print(f"{'PASS' if passed else 'FAIL'}  {label}  [{rule}]")
    print("ALL PASS" if ok else "FAILED")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
