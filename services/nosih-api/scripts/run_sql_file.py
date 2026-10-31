"""Run a SQL file against the Supabase database and print result rows."""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402


def main() -> None:
    sql = Path(sys.argv[1]).read_text(encoding="utf-8")
    with connect() as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            statements = [part.strip() for part in re.split(r";\s*\n", sql) if part.strip()]
            for statement in statements:
                cur.execute(statement)
                if cur.description:
                    print([c.name for c in cur.description])
                    for row in cur.fetchall():
                        print(row)
                    print()
                else:
                    print(f"rows affected: {cur.rowcount}")


if __name__ == "__main__":
    main()
