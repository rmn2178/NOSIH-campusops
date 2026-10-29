"""Upload a tiny PNG as the signed-in admin and read it back publicly."""

from __future__ import annotations

import base64
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
)


def request(path: str, *, token: str | None = None, data: bytes | None = None, content_type: str = "application/json"):
    headers = {"apikey": settings.supabase_publishable_key or ""}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if data is not None:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(
        f"{settings.supabase_url}{path}",
        data=data,
        headers=headers,
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def main() -> None:
    status, body = request(
        "/auth/v1/token?grant_type=password",
        data=json.dumps({"email": "incident@nosih.edu.in", "password": "Nosih@2026"}).encode(),
    )
    if status != 200:
        raise SystemExit(f"sign-in failed: {status} {body[:200]}")
    session = json.loads(body)
    token = session["access_token"]
    uid = session["user"]["id"]

    key = f"{uid}/probe.png"
    status, body = request(
        f"/storage/v1/object/complaint-evidence/{key}",
        token=token,
        data=PNG,
        content_type="image/png",
    )
    print("upload:", status, body[:200])

    public_url = f"{settings.supabase_url}/storage/v1/object/public/complaint-evidence/{key}"
    req = urllib.request.Request(public_url)
    with urllib.request.urlopen(req, timeout=30) as response:
        blob = response.read()
    print("public read:", response.status, len(blob), "bytes")


if __name__ == "__main__":
    main()
