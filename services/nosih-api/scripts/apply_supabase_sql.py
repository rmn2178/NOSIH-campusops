"""Apply every SQL file in supabase/migrations in filename order."""

from __future__ import annotations

import sys
from pathlib import Path

import psycopg
from psycopg.pq import ExecStatus

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402


def main() -> None:
    root = Path(__file__).resolve().parents[3] / "supabase" / "migrations"
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        for path in sorted(root.glob("*.sql")):
            sql = path.read_text(encoding="utf-8")
            result = conn.pgconn.exec_(sql.encode("utf-8"))
            if result.status not in (ExecStatus.COMMAND_OK, ExecStatus.TUPLES_OK):
                message = result.error_message.decode("utf-8", "replace")
                print(f"FAILED {path.name}: {message}")
                raise SystemExit(1)
            print(f"applied {path.name}")


if __name__ == "__main__":
    main()
