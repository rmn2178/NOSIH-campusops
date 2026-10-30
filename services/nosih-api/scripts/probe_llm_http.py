"""Probe the raw LLM endpoint: status, error body, model and endpoint."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("select public.nosih_llm_endpoint(), public.nosih_llm_model()")
            endpoint, model = cur.fetchone()
            cur.execute(
                "select public.nosih_llm_post(%s::jsonb, 20000)",
                (json.dumps({
                    "messages": [{"role": "user", "content": "Reply with the single word: pong"}],
                    "max_tokens": 16,
                }),),
            )
            body = cur.fetchone()[0]
    print("endpoint:", endpoint)
    print("model:", model)
    print(json.dumps(body, indent=2)[:1200])


if __name__ == "__main__":
    main()
