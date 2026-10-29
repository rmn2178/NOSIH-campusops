"""Apply one SQL migration file to the Supabase database.

Usage: .venv/Scripts/python.exe scripts/apply_sql_file.py <path-to-sql>
"""
from __future__ import annotations

import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402


def main() -> None:
    path = Path(sys.argv[1]).resolve()
    sql = path.read_text(encoding="utf-8")
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
    print(f"applied {path.name} ({len(sql)} chars)")


if __name__ == "__main__":
    main()
