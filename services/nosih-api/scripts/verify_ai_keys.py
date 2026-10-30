"""Verify the AI key pool: rotation works and key material stays server-side.

Run with the project virtualenv from services/nosih-api:
  .venv/Scripts/python.exe scripts/verify_ai_keys.py
"""

import os
import sys
from urllib.parse import urlsplit, urlunsplit

import psycopg
from dotenv import load_dotenv

failures: list[str] = []


def check(label: str, passed: bool, detail: object = "") -> None:
    print(("PASS  " if passed else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not passed:
        failures.append(label)


def connect():
    load_dotenv("services/nosih-api/.env")
    load_dotenv(".env")
    url = os.environ["DATABASE_URL"].replace("postgresql+psycopg://", "postgresql://", 1)
    try:
        return psycopg.connect(url, connect_timeout=8)
    except psycopg.OperationalError:
        parts = urlsplit(url)
        proj = (parts.hostname or "").removeprefix("db.").removesuffix(".supabase.co")
        netloc = f"postgres.{proj}:{parts.password}@aws-0-eu-west-1.pooler.supabase.com:{parts.port or 5432}"
        return psycopg.connect(urlunsplit((parts.scheme, netloc, parts.path, parts.query, "")),
                               connect_timeout=10, sslmode="require")


def main() -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select public.nosih_ai_key_count()")
        count = cur.fetchone()[0]
        check("K1 the key pool holds more than one key", count >= 2, count)

        cur.execute("select public.nosih_llm_endpoint(), public.nosih_llm_model()")
        endpoint, model = cur.fetchone()
        check("K2 the pool routes to Groq", "api.groq.com" in endpoint, (endpoint, model))

        cur.execute("""select has_function_privilege('anon', 'public.nosih_ai_keys()', 'EXECUTE'),
                              has_function_privilege('authenticated', 'public.nosih_ai_keys()', 'EXECUTE'),
                              has_function_privilege('authenticated', 'public.nosih_llm_post(jsonb, integer)', 'EXECUTE')""")
        anon_pool, auth_pool, auth_post = cur.fetchone()
        check("K3 key material and the HTTP helper stay server-side",
              anon_pool is False and auth_pool is False and auth_post is False,
              (anon_pool, auth_pool, auth_post))

        replies = []
        for _ in range(3):
            cur.execute("select public.nosih_grok_text('You are terse.', 'Reply with the single word READY')")
            replies.append(cur.fetchone()[0])
        check("K4 successive calls succeed while rotating keys",
              all(reply and "READY" in reply.upper() for reply in replies), replies)

    print(f"\nRESULT: {'ALL PASS' if not failures else f'{len(failures)} FAILURE(S)'}")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
