"""Register AI provider keys in the Supabase Vault pool.

Prompt-only: keys are never written to disk or printed. The runtime reads the
pool through public.nosih_llm_* helpers, starts each call at the next key and
fails over on auth, quota, rate-limit and server errors. `gsk_` keys route to
Groq, `xai-` keys to x.ai.

Usage (from services/nosih-api):
  .venv/Scripts/python.exe scripts/set_ai_key.py
  printf '%s\n' "$KEY1" "$KEY2" | .venv/Scripts/python.exe scripts/set_ai_key.py
"""

from __future__ import annotations

import getpass
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402


def connect():
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    try:
        return psycopg.connect(url, connect_timeout=8, autocommit=True)
    except psycopg.OperationalError:
        parts = urlsplit(url)
        proj = (parts.hostname or "").removeprefix("db.").removesuffix(".supabase.co")
        netloc = f"postgres.{proj}:{parts.password}@aws-0-eu-west-1.pooler.supabase.com:{parts.port or 5432}"
        return psycopg.connect(urlunsplit((parts.scheme, netloc, parts.path, parts.query, "")),
                               connect_timeout=10, sslmode="require", autocommit=True)


def read_keys() -> list[str]:
    if sys.stdin.isatty():
        key = getpass.getpass("AI provider key (hidden): ").strip()
        return [key] if key else []
    return [line.strip() for line in sys.stdin.read().splitlines() if line.strip()]


def main() -> None:
    load_dotenv(".env")
    keys = read_keys()
    if not keys:
        print("no key supplied")
        raise SystemExit(2)
    if any(not (key.startswith("gsk_") or key.startswith("xai-")) for key in keys):
        print("warning: a key does not look like a Groq (gsk_) or x.ai (xai-) key")

    with connect() as conn, conn.cursor() as cur:
        cur.execute("select public.nosih_register_ai_keys(%s::jsonb)", (json.dumps(keys),))
        result = cur.fetchone()[0]
        cur.execute("select public.nosih_ai_key_count(), public.nosih_llm_endpoint(), public.nosih_llm_model()")
        count, endpoint, model = cur.fetchone()
        print(f"registered {len(keys)} key(s); pool now {count} -> {endpoint} · {model}")


if __name__ == "__main__":
    main()
