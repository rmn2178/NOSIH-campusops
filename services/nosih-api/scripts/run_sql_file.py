"""Run a SQL file against the Supabase database and print result rows."""
from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402


def main() -> None:
    sql = Path(sys.argv[1]).read_text(encoding="utf-8")
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            if cur.description:
                print([c.name for c in cur.description])
                for row in cur.fetchall():
                    print(row)
            else:
                print(f"rows affected: {cur.rowcount}")


if __name__ == "__main__":
    main()
