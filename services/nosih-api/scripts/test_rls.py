"""Exercise Supabase Auth + RLS from the client's perspective."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402


def call(path: str, token: str | None = None, payload: dict | None = None) -> tuple[int, str]:
    headers = {"apikey": settings.supabase_publishable_key or "", "Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        f"{settings.supabase_url}{path}",
        data=data,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode()


def main() -> None:
    print("anon complaints:", call("/rest/v1/complaints?select=id,moderation_status&limit=2")[0])
    print("anon rooms:", call("/rest/v1/rooms?select=code&limit=2"))
    print("anon vault:", call("/rest/v1/identity_vault?select=id&limit=1"))

    status, body = call(
        "/auth/v1/token?grant_type=password",
        payload={"email": "incident@nosih.edu.in", "password": "Nosih@2026"},
    )
    print("\nsign-in:", status)
    if status != 200:
        print(body)
        return
    token = json.loads(body)["access_token"]
    status, body = call("/rest/v1/rooms?select=code&limit=2", token)
    print("admin rooms:", status, body[:200])
    status, body = call("/rest/v1/identity_vault?select=id&limit=1", token)
    print("admin vault:", status, body[:200])
    status, body = call("/rest/v1/users?select=email&limit=2", token)
    print("admin users:", status, body[:200])


if __name__ == "__main__":
    main()
