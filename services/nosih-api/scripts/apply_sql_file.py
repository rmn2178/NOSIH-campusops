"""Apply one SQL migration file to the Supabase database.

Usage: .venv/Scripts/python.exe scripts/apply_sql_file.py <path-to-sql>
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect  # noqa: E402


def main() -> None:
    path = Path(sys.argv[1]).resolve()
    sql = path.read_text(encoding="utf-8")
    with connect() as conn:
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute(sql)
    print(f"applied {path.name} ({len(sql)} chars)")


if __name__ == "__main__":
    main()
