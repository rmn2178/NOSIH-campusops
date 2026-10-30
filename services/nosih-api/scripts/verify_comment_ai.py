"""Verify comments are moderated by the live model, not a keyword fallback.

Proves the Groq endpoint is active, that the model returns a verdict and a
polite rewrite, and that rpc_post_comment hands that rewrite back to the
portal. Everything runs in one rolled-back transaction.

Run with the project virtualenv from services/nosih-api:
  .venv/Scripts/python.exe scripts/verify_comment_ai.py
"""

import json
import os
import sys
from urllib.parse import urlsplit, urlunsplit

import psycopg
from dotenv import load_dotenv

BENIGN = "The projector in C5-02 flickers during lectures and one ceiling fan has stopped."
RUDE = "This useless staff never fix anything, what a stupid system"

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


def as_user(cur, uuid: str) -> None:
    cur.execute("set role postgres")
    cur.execute("select set_config('request.jwt.claims', %s, true)",
                (json.dumps({"sub": uuid, "role": "authenticated"}),))
    cur.execute("set role authenticated")


def main() -> None:
    conn = connect()
    cur = conn.cursor()
    try:
        cur.execute("select public.nosih_llm_endpoint(), public.nosih_llm_model()")
        endpoint, model = cur.fetchone()
        check("M1 moderation is routed to Groq", "api.groq.com" in endpoint, (endpoint, model))

        cur.execute("select public.nosih_ai_moderate_text(%s)", (BENIGN,))
        benign = cur.fetchone()[0]
        check("M2 a factual facility complaint is approved by the model",
              benign.get("status") == "APPROVED" and benign.get("engine") == "llm", benign)

        cur.execute("select public.nosih_ai_moderate_text(%s)", (RUDE,))
        rude = cur.fetchone()[0]
        check("M3 a personal insult is rewritten by the model",
              rude.get("status") == "NEEDS_REWRITE" and rude.get("engine") == "llm"
              and bool(rude.get("rewrite")), rude)

        cur.execute("select auth_user_id, email from public.users where email = 'aids1a01@nosih.edu.in'")
        student_uuid, student_email = cur.fetchone()
        cur.execute("select id from public.complaints where moderation_status = 'APPROVED' "
                    "and status in ('TRIAGED', 'OPEN', 'IN_PROGRESS') order by id limit 1")
        complaint_id = cur.fetchone()[0]

        as_user(cur, str(student_uuid))
        cur.execute("select public.rpc_post_comment(%s::jsonb)", (json.dumps({
            "complaint_id": complaint_id,
            "email": student_email,
            "body": RUDE,
            "is_anonymous": False,
        }),))
        posted = cur.fetchone()[0]
        check("M4 the real comment path returns the model verdict",
              posted.get("success") is True and posted.get("moderation_status") == "NEEDS_REWRITE",
              posted.get("moderation_status"))
        check("M5 the portal receives the polite rewrite",
              bool(posted.get("suggested_polite_rewrite")), posted.get("suggested_polite_rewrite"))

        cur.execute("set role postgres")
        cur.execute("select moderation_status from public.complaint_comments "
                    "where complaint_id = %s and body = %s order by id desc limit 1",
                    (complaint_id, RUDE))
        row = cur.fetchone()
        check("M6 the held comment is stored out of the public feed",
              row is not None and row[0] == "NEEDS_REWRITE", row)
    finally:
        conn.rollback()
        conn.close()

    print(f"\nRESULT: {'ALL PASS' if not failures else f'{len(failures)} FAILURE(S)'}")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
