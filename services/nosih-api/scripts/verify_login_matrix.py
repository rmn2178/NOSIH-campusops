"""Prove every campus identity can sign in, without the mail service.

The portal used to open a missing account with the browser sign-up call. That
sends a confirmation email, the campus mail quota cannot afford it, and
@nosih.edu.in mail does not exist anyway, so a login could only ever fail.
Every member of the campus register now holds a seat, and the portal never
asks the mail service for anything.

Checks:

1. Every active profile holds a seat.
2. Every role signs in over the token endpoint with the demo password.
3. A wrong password is refused, and an unknown email is refused.
4. A failed sign-in creates no account and sends no mail.
5. No portal source calls the auth sign-up endpoint any more.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _db import connect, enable_utf8_stdout  # noqa: E402
from app.config import settings  # noqa: E402

enable_utf8_stdout()

DEMO_PASSWORD = "Nosih@2026"
ROOT = Path(__file__).resolve().parents[3]
ROLES = [
    "STUDENT",
    "FACULTY",
    "LAB_STAFF",
    "MAINTENANCE",
    "DEPARTMENT_MANAGER",
    "FACILITIES_ADMIN",
    "INCIDENT_MANAGER",
    "PROCUREMENT_APPROVER",
    "SYSTEM_ADMIN",
]

failures: list[str] = []


def check(label: str, ok: bool, detail: object = "") -> None:
    print(("PASS  " if ok else "FAIL  ") + label + (f"  -> {detail}" if detail != "" else ""))
    if not ok:
        failures.append(label)


def sign_in(email: str, password: str) -> tuple[int, dict]:
    payload = json.dumps({"email": email, "password": password}).encode()
    request = urllib.request.Request(
        f"{settings.supabase_url}/auth/v1/token?grant_type=password",
        data=payload,
        headers={
            "apikey": settings.supabase_publishable_key or "",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except json.JSONDecodeError:
            return exc.code, {"raw": body[:200]}


def auth_user_count() -> int:
    request = urllib.request.Request(
        f"{settings.supabase_url}/auth/v1/admin/users?per_page=1",
        headers={
            "apikey": settings.supabase_admin_key or "",
            "Authorization": f"Bearer {settings.supabase_admin_key or ''}",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return int(response.headers.get("x-total-count") or 0)


def main() -> None:
    with connect() as conn:
        cur = conn.cursor()

        cur.execute("""
            select role, count(*) filter (where auth_user_id is null) as missing, count(*) as total
              from public.users where is_active group by role order by role""")
        by_role = cur.fetchall()
        missing = sum(row[1] for row in by_role)
        total = sum(row[2] for row in by_role)
        check("L1 every active profile holds a portal seat", missing == 0,
              f"{total - missing}/{total} seated" if missing else f"{total} seated")

        cur.execute("""
            select role, email, full_name from public.users
             where is_active and auth_user_id is not null
             order by role, email""")
        seated = cur.fetchall()
        conn.rollback()

    samples: list[tuple[str, str, str]] = []
    for role in ROLES:
        row = next((item for item in seated if item[0] == role), None)
        check(f"L2 a {role} account is seated", row is not None, row[1] if row else "none")
        if row:
            samples.append((role, row[1], row[2]))

    signed_in = 0
    for role, email, _name in samples:
        status, body = sign_in(email, DEMO_PASSWORD)
        ok = status == 200 and bool(body.get("access_token"))
        if ok:
            signed_in += 1
        check(f"L3 the {role} signs in with the demo password", ok,
              body.get("msg") or body.get("error_description") or "")
    check("L4 every role signed in", signed_in == len(samples), f"{signed_in}/{len(samples)}")

    if samples:
        _role, email, _name = samples[0]
        before = auth_user_count()
        status, body = sign_in(email, "not-the-campus-password")
        after = auth_user_count()
        check("L5 a wrong password is refused",
              status in (400, 401) and not body.get("access_token"),
              body.get("msg") or body.get("error_description") or status)
        check("L6 a refused sign-in creates no account and sends no mail",
              before == after, f"auth users {before} -> {after}")

    status, body = sign_in("nobody-here@nosih.edu.in", DEMO_PASSWORD)
    check("L7 an unknown email is refused cleanly",
          status in (400, 401) and not body.get("access_token"),
          body.get("msg") or body.get("error_description") or status)

    # The mail path must stay closed: no portal source may ask the auth
    # service to sign somebody up.
    offenders: list[str] = []
    for folder in ("apps", "packages"):
        for path in (ROOT / folder).rglob("*.ts*"):
            if "node_modules" in path.parts or "dist" in path.parts:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            if "auth.signUp" in text or "signUp(" in text:
                offenders.append(str(path.relative_to(ROOT)))
    check("L8 no portal source calls the auth sign-up endpoint", not offenders, offenders)

    print("\nRESULT:", "ALL PASS" if not failures else f"{len(failures)} FAILURE(S)")
    sys.exit(0 if not failures else 1)


if __name__ == "__main__":
    main()
