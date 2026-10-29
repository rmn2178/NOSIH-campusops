"""Ad-hoc probe: call the AI chatbot RPC as a given user (sets JWT claims)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

USER_UUID = sys.argv[1] if len(sys.argv) > 1 else "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
PORTAL = sys.argv[2] if len(sys.argv) > 2 else "COMPLAINT"
SPACE = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "-" else None
QUESTION = sys.argv[4] if len(sys.argv) > 4 else "What is the current state of my space?"


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": USER_UUID, "role": "authenticated"}),),
            )
            cur.execute("set role authenticated")
            cur.execute(
                "select public.rpc_ai_chat(%s::jsonb, %s, %s, null)",
                (
                    json.dumps([{"role": "user", "content": QUESTION}]),
                    PORTAL,
                    SPACE,
                ),
            )
            row = cur.fetchone()
            print(json.dumps(row[0], indent=2, default=str))


if __name__ == "__main__":
    main()
