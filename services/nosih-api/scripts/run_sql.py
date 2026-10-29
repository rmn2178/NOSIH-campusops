"""Run one ad-hoc SQL statement against the Supabase database."""
from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402


def main() -> None:
    sql = sys.argv[1]
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
            if cur.description:
                columns = [item.name for item in cur.description]
                print(columns)
                for row in cur.fetchall():
                    print(row)
            else:
                print(f"rows affected: {cur.rowcount}")


if __name__ == "__main__":
    main()
