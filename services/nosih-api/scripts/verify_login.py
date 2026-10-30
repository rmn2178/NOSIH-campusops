"""Verify a seeded portal login without printing tokens.

Usage: .venv/Scripts/python.exe scripts/verify_login.py [email]
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import settings  # noqa: E402
from _db import enable_utf8_stdout  # noqa: E402

enable_utf8_stdout()

EMAIL = sys.argv[1] if len(sys.argv) > 1 else "sysadmin@nosih.edu.in"
PASSWORD = "Nosih@2026"


def main() -> None:
    payload = json.dumps({"email": EMAIL, "password": PASSWORD}).encode()
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
            body = json.loads(response.read())
        user = body.get("user", {})
        metadata = user.get("user_metadata", {})
        print(f"PASS  {EMAIL} signs in")
        print(f"      role={metadata.get('role')} name={metadata.get('full_name')} linked={user.get('id') is not None}")
        print(f"      token received: {'access_token' in body} (not printed)")
    except urllib.error.HTTPError as exc:
        print(f"FAIL  {EMAIL}: {exc.code} {exc.read().decode('utf-8', 'replace')[:160]}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
