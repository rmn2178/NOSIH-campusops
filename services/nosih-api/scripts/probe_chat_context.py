"""Measure the chat context and whether the question survives prompt truncation."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402

USER_UUID = sys.argv[1] if len(sys.argv) > 1 else "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
SPACE = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "-" else None


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
                "select length(public.nosih_chat_context('ADMIN', %s)::text)",
                (SPACE,),
            )
            ctx_len = cur.fetchone()[0]
            cur.execute(
                "select public.nosih_chat_context('ADMIN', %s)::text",
                (SPACE,),
            )
            ctx = cur.fetchone()[0]
            cur.execute(
                """
                select key, length(value::text)
                  from jsonb_each(public.nosih_chat_context('ADMIN', %s)) as t(key, value)
                 order by 2 desc
                """,
                (SPACE,),
            )
            parts = cur.fetchall()
    print(f"context chars: {ctx_len}")
    print(f"grok_json cap: 24000 -> question visible: {'NO' if ctx_len >= 24000 else 'yes'}")
    print("context head:", ctx[:160].replace("\n", " "))
    print("context tail:", ctx[-160:].replace("\n", " "))
    print("largest parts:")
    for key, size in parts:
        print(f"  {key:<22} {size:>6}")


if __name__ == "__main__":
    main()
