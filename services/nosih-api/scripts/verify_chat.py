"""Verify the NOSIH chatbot: question visibility, grounding, history and ownership.

Runs as a real signed-in user, calls rpc_ai_chat twice in one conversation and
checks the replies against the live snapshot. All writes are rolled back.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402
from _db import enable_utf8_stdout  # noqa: E402

enable_utf8_stdout()

USER_UUID = "1fe499e7-739a-46e1-a8c3-ee1c82dfcb9e"
SPACE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "-" else None

CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, ok, detail))


def chat(cur, messages: list[dict], conversation_id: str | None = None) -> tuple[dict, float]:
    started = time.perf_counter()
    cur.execute(
        "select public.rpc_ai_chat(%s::jsonb, 'ADMIN', %s, %s)",
        (json.dumps(messages), SPACE, conversation_id),
    )
    payload = cur.fetchone()[0]
    return payload, time.perf_counter() - started


def main() -> None:
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "select set_config('request.jwt.claims', %s, false)",
                (json.dumps({"sub": USER_UUID, "role": "authenticated"}),),
            )
            cur.execute("set role authenticated")
            cur.execute(
                "select public.nosih_chat_context('ADMIN', %s)",
                (SPACE,),
            )
            ctx = cur.fetchone()[0]
            ctx_len = len(json.dumps(ctx))

            check("context fits the 24k prompt cap", ctx_len < 24000, f"{ctx_len} chars")
            unhealthy = [s["code"] for s in ctx.get("unhealthy_spaces", [])]

            q1 = "Which spaces are unhealthy right now?"
            first, elapsed = chat(cur, [{"role": "user", "content": q1}])
            reply1 = (first.get("reply") or "").strip()
            check("first reply succeeds", bool(first.get("success")), str(first.get("error") or ""))
            check("first reply uses the live model", first.get("engine") == "grok", str(first.get("engine")))
            check("question is not reported missing", "don't see" not in reply1.lower() and "no question" not in reply1.lower(), reply1[:120])
            check("reply is non-empty", len(reply1) > 20, f"{len(reply1)} chars")
            if unhealthy:
                mentioned = [code for code in unhealthy if code in reply1]
                check("reply names a real unhealthy space", bool(mentioned), f"{unhealthy} -> {mentioned}")
            check("latency under 20s", elapsed < 20, f"{elapsed:.1f}s")

            conv = first.get("conversation_id")
            q2 = "Of those, which one has the most urgent open work order?"
            second, elapsed2 = chat(
                cur,
                [
                    {"role": "user", "content": q1},
                    {"role": "assistant", "content": reply1},
                    {"role": "user", "content": q2},
                ],
                conv,
            )
            reply2 = (second.get("reply") or "").strip()
            check("follow-up succeeds", bool(second.get("success")), str(second.get("error") or ""))
            check("follow-up keeps the conversation", second.get("conversation_id") == conv, str(second.get("conversation_id")))
            check("follow-up is grounded in a real code", any(code in reply2 for code in unhealthy), reply2[:160])
            check("follow-up latency under 20s", elapsed2 < 20, f"{elapsed2:.1f}s")

            # A conversation owned by someone else must not be appended to.
            cur.execute("reset role")
            cur.execute(
                "select auth_user_id from public.users where auth_user_id is not null and auth_user_id <> %s limit 1",
                (USER_UUID,),
            )
            other = cur.fetchone()
            check("another owner exists for the hijack test", other is not None, "")
            if other:
                cur.execute(
                    """
                    insert into public.ai_chat_messages (conversation_id, owner_id, author_role, portal, body)
                    values (gen_random_uuid(), %s, 'USER', 'ADMIN', 'private conversation')
                    returning conversation_id
                    """,
                    (other[0],),
                )
                foreign_conv = cur.fetchone()[0]
                cur.execute(
                    "select set_config('request.jwt.claims', %s, false)",
                    (json.dumps({"sub": USER_UUID, "role": "authenticated"}),),
                )
                cur.execute("set role authenticated")
                hijack, _ = chat(cur, [{"role": "user", "content": "continue"}], str(foreign_conv))
                check(
                    "foreign conversation id is not hijacked",
                    hijack.get("conversation_id") != str(foreign_conv),
                    str(hijack.get("conversation_id")),
                )

        conn.rollback()

    failed = [entry for entry in CHECKS if not entry[1]]
    for name, ok, detail in CHECKS:
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} passed")
    print("reply 1:", reply1)
    print("reply 2:", reply2)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
