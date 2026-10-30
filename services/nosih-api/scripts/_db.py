"""One database connection path for every verification and maintenance script.

The service `.env` is resolved from this file, not from the caller's working
directory, so a script behaves the same when launched from the repository root,
from `services/nosih-api`, or from CI. Direct Supabase hosts are tried first;
when they have no route (IPv6-only outage) the Supavisor pooler is used.
"""

from __future__ import annotations

import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
from dotenv import load_dotenv

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]

# The service file wins for keys that exist in both; the root file only fills gaps.
load_dotenv(SERVICE_ROOT / ".env")
load_dotenv(REPO_ROOT / ".env")

if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from app.config import settings  # noqa: E402


def enable_utf8_stdout() -> None:
    """Model output contains Unicode spaces and punctuation; the Windows console
    defaults to cp1252 and crashes on it. Force UTF-8 with replacement."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


enable_utf8_stdout()


def database_url() -> str:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    if not url.startswith(("postgresql://", "postgres://")):
        raise RuntimeError(
            "DATABASE_URL is not configured. Copy services/nosih-api/.env.example "
            "to services/nosih-api/.env and fill the pooler connection string."
        )
    return url


def connect(timeout: int = 15) -> psycopg.Connection:
    url = database_url()
    try:
        return psycopg.connect(url, connect_timeout=timeout)
    except psycopg.OperationalError:
        parts = urlsplit(url)
        if not parts.password or not parts.hostname or not parts.hostname.startswith("db."):
            raise
        project = parts.hostname.removeprefix("db.").removesuffix(".supabase.co")
        netloc = (
            f"postgres.{project}:{parts.password}"
            f"@aws-0-eu-west-1.pooler.supabase.com:{parts.port or 5432}"
        )
        pooled = urlunsplit((parts.scheme, netloc, parts.path, parts.query, ""))
        return psycopg.connect(pooled, connect_timeout=timeout + 15, sslmode="require")
