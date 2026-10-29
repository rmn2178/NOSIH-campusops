"""Exercise the exact browser contract: Auth + PostgREST RPCs."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402


def call(path: str, *, token: str | None = None, payload: dict | None = None) -> tuple[int, object]:
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
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(body)
        except ValueError:
            return exc.code, body


def main() -> None:
    status, session = call(
        "/auth/v1/token?grant_type=password",
        payload={"email": "aids1a01@nosih.edu.in", "password": "Nosih@2026"},
    )
    if status != 200 or not isinstance(session, dict):
        raise SystemExit(f"sign-in failed: {status} {session}")
    token = session["access_token"]
    print("sign-in:", status, session["user"]["email"])

    print("profile:", call("/rest/v1/rpc/rpc_my_profile", token=token, payload={}))

    status, feed = call(
        "/rest/v1/rpc/rpc_list_complaints",
        token=token,
        payload={"p_zone": "ALL", "p_status": None, "p_category": None, "p_my_department": False, "p_limit": 5},
    )
    print("feed:", status, len(feed) if isinstance(feed, list) else feed)

    status, space = call(
        "/rest/v1/rpc/rpc_get_space_twin_inspector",
        token=token,
        payload={"p_space_input": "C5-02"},
    )
    print("space:", status, space.get("code"), len(space.get("assets") or []), "assets")

    status, created = call(
        "/rest/v1/rpc/rpc_submit_complaint",
        token=token,
        payload={"p_payload": {
            "email": "aids1a01@nosih.edu.in",
            "is_anonymous": False,
            "space_code": "C5-02",
            "description": "The projector in C5-02 is flickering and one ceiling fan is not working.",
            "target_assets": [
                {"asset_type": "SMART_BOARD", "asset_codes": ["SB-C5-02-01"]},
                {"asset_type": "CEILING_FAN", "asset_codes": ["FAN-C5-02-01"]},
            ],
            "source_channel": "WEB_PORTAL",
        }},
    )
    complaint = created.get("complaint") if isinstance(created, dict) else {}
    print("submit:", status, complaint.get("ticket_number"), complaint.get("category"),
          complaint.get("urgency"), complaint.get("status"))
    complaint_id = complaint.get("id")

    status, vote = call(
        "/rest/v1/rpc/rpc_confirm_affected",
        token=token,
        payload={"p_complaint_id": complaint_id, "p_voter_hash": ""},
    )
    print("affected:", status, vote)

    status, comment = call(
        "/rest/v1/rpc/rpc_post_comment",
        token=token,
        payload={"p_payload": {
            "complaint_id": complaint_id,
            "email": "aids1a01@nosih.edu.in",
            "body": "Confirmed in our afternoon session too.",
            "is_anonymous": False,
        }},
    )
    print("comment:", status, (comment.get("comment") or {}).get("author_label"))

    status, detail = call(
        "/rest/v1/rpc/rpc_get_complaint",
        token=token,
        payload={"p_complaint_id": complaint_id},
    )
    print("detail:", status, detail.get("ticket_number"), "comments:",
          len(detail.get("comments") or []), "voted:", detail.get("viewer_has_voted"))


if __name__ == "__main__":
    main()
