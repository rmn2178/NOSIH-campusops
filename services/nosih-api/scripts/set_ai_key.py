"""Rotate the AI provider key stored in Supabase Vault.

Prompt-only: the key is never written to disk or printed. The runtime reads it
from Vault through public.nosih_llm_* helpers, so a `gsk_` key routes to Groq
and any other key to x.ai.

Usage (from services/nosih-api):
  .venv/Scripts/python.exe scripts/set_ai_key.py
"""

from __future__ import annotations

import getpass
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


def main() -> None:
    load_dotenv(".env")
    key = getpass.getpass("AI provider key (hidden): ").strip()
    if not key:
        print("no key supplied")
        raise SystemExit(2)
    if not key.startswith("gsk_") and not key.startswith("xai-"):
        print("warning: key does not look like a Groq (gsk_) or x.ai (xai-) key")

    with connect() as conn, conn.cursor() as cur:
        cur.execute("select id from vault.secrets where name = 'xai_api_key'")
        row = cur.fetchone()
        if row:
            cur.execute("select vault.update_secret(%s, %s)", (row[0], key))
        else:
            cur.execute("select vault.create_secret(%s, 'xai_api_key', 'NOSIH AI provider key')", (key,))
        cur.execute("select public.nosih_llm_endpoint(), public.nosih_llm_model()")
        endpoint, model = cur.fetchone()
        print(f"stored xai_api_key ({len(key)} chars) -> {endpoint} · {model}")


if __name__ == "__main__":
    main()
