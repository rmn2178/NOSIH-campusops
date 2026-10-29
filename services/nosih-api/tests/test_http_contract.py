"""End-to-end HTTP contract tests against a deterministically seeded database."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.seed.seed_campus import seed_campus


@pytest.fixture(scope="module")
def client():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        seed_campus(db)

    def override_db():
        with Session(engine, expire_on_commit=False) as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    test_client = TestClient(app)
    yield test_client
    app.dependency_overrides.clear()
    engine.dispose()


def admin_headers(client: TestClient, email: str = "sysadmin@nosih.edu.in") -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": "Nosih@2026"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def student_headers(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/auth/portal-login",
        json={"email": "cse1a01@nosih.edu.in", "department": "CSE", "academic_role": "YEAR_1"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_command_login_requires_the_seeded_password(client: TestClient):
    assert client.post("/api/auth/login", json={"email": "sysadmin@nosih.edu.in", "password": "wrong"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "cse1a01@nosih.edu.in", "password": "Nosih@2026"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "sysadmin@nosih.edu.in", "password": "Nosih@2026"}).status_code == 200


def test_twin_and_timetable_contracts(client: TestClient):
    overview = client.get("/api/twin/overview")
    assert overview.status_code == 200
    assert len(overview.json()["spaces"]) == 123
    validation = client.get("/api/timetable/validate").json()
    assert validation["valid"] is True
    assert validation["total_slots"] == 2700
    space = client.get("/api/twin/space/A1-01").json()
    assert {"period_cards", "full_day_timeline", "assets", "maintenance_history"} <= set(space)


def test_anonymous_complaint_runs_moderation_vault_and_twin_mutation(client: TestClient):
    headers = student_headers(client)
    rejected = client.post(
        "/api/complaints",
        headers=headers,
        json={"space_code": "A1-01", "description": "This room is bullshit garbage", "is_anonymous": True},
    )
    assert rejected.status_code == 201
    assert rejected.json()["moderation_status"] == "NEEDS_REWRITE"

    created = client.post(
        "/api/complaints",
        headers=headers,
        json={
            "space_code": "A1-01",
            "description": "The ceiling fan is sparking and smoke is coming from the motor.",
            "is_anonymous": True,
            "target_assets": [{"asset_code": "FAN-A1-01-01", "asset_type": "CEILING_FAN", "slot_index": 1}],
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["moderation_status"] == "APPROVED"
    assert body["complaint"]["is_anonymous"] is True
    assert "vault_token" not in body["complaint"]
    assert client.get("/api/twin/space/A1-01").json()["visual_state"] == "FAULTY"

    admin = admin_headers(client)
    queue = client.get("/api/admin/moderation", headers=admin).json()
    held = next(item for item in queue if item["moderation_status"] == "NEEDS_REWRITE")
    unsealed = client.post(
        f"/api/admin/vault/{held['vault_token']}/unseal",
        headers=admin,
        json={
            "justification_reason": "Safety investigation requires identifying the anonymous reporter.",
            "policy_clause": "THREAT_TO_LIFE_SAFETY",
        },
    )
    assert unsealed.status_code == 200
    assert unsealed.json()["identity"]["email"].startswith("cse1a01")
    approved = client.post(f"/api/admin/moderation/complaints/{held['complaint_id']}/approve", headers=admin)
    assert approved.status_code == 200
    assert approved.json()["moderation_status"] == "APPROVED"
    assert client.get(f"/api/complaints/{held['complaint_id']}").status_code == 200


def test_locks_are_operator_only_and_lock_ids_are_strings(client: TestClient):
    student = student_headers(client)
    assert client.post("/api/locks/claim", headers=student, json={"resource_type": "ROOM", "resource_id": "A1-02"}).status_code == 403
    admin = admin_headers(client, "facilities@nosih.edu.in")
    claimed = client.post("/api/locks/claim", headers=admin, json={"resource_type": "ROOM", "resource_id": "A1-02"})
    assert claimed.status_code == 200
    assert isinstance(claimed.json()["id"], str)
    assert client.post("/api/locks/heartbeat", headers=admin, json={"lock_id": claimed.json()["id"]}).status_code == 200
    assert client.post("/api/locks/release", headers=admin, json={"lock_id": claimed.json()["id"]}).status_code == 200


def test_staff_assignment_parts_shortage_and_procurement(client: TestClient):
    admin = admin_headers(client, "facilities@nosih.edu.in")
    work_orders = client.get("/api/admin/work-orders", headers=admin).json()
    ranking = None
    work_order = None
    for item in work_orders:
        if item["status"] != "OPEN" or item["assigned_staff_code"]:
            continue
        response = client.get(f"/api/work-orders/{item['id']}/staff-ranking", headers=admin)
        if response.status_code == 200 and response.json()["available_ranked"]:
            ranking = response.json()
            work_order = item
            break
    assert work_order is not None and ranking is not None
    candidate = ranking["available_ranked"][0]
    staff_lock = client.post(
        "/api/locks/claim", headers=admin, json={"resource_type": "STAFF", "resource_id": candidate["staff_code"]}
    ).json()
    assigned = client.post(
        f"/api/work-orders/{work_order['id']}/assign-staff",
        headers=admin,
        json={"staff_code": candidate["staff_code"], "lock_id": staff_lock["id"]},
    )
    assert assigned.status_code == 200

    wo_lock = client.post(
        "/api/locks/claim", headers=admin, json={"resource_type": "WORK_ORDER", "resource_id": str(work_order["id"])}
    ).json()
    preflight = client.get(f"/api/work-orders/{work_order['id']}/parts-preflight", headers=admin).json()
    sku = preflight["requested_parts"][0]["sku_code"]
    reserved = client.post(
        f"/api/work-orders/{work_order['id']}/reserve-parts",
        headers=admin,
        json={"parts": [{"sku_code": sku, "qty": 1}], "lock_id": wo_lock["id"]},
    )
    assert reserved.status_code == 200
    shortage = reserved.json()
    assert shortage["reserved"] is False and shortage["stock_out"] is True

    procurement = admin_headers(client, "procurement@nosih.edu.in")
    requests = client.get("/api/admin/purchase-requests", headers=procurement).json()
    pending = next(item for item in requests if item["status"] == "PENDING_APPROVAL")
    preflight = client.get(f"/api/purchase-requests/{pending['id']}/approval-preflight", headers=procurement)
    assert preflight.status_code == 200
    assert all(check["passed"] for check in preflight.json()["checks"])
    assert client.post(f"/api/purchase-requests/{pending['id']}/approve", headers=procurement).status_code == 200

    completed = client.post(
        f"/api/work-orders/{work_order['id']}/complete",
        headers=admin,
        json={"resolution_notes": "Replaced the failed component and verified operation."},
    )
    assert completed.status_code == 200
    assert completed.json()["status"] == "RESOLVED"


def test_audit_chain_verifies_after_mutations(client: TestClient):
    admin = admin_headers(client)
    verification = client.get("/api/audit/verify", headers=admin).json()
    assert verification["verified"] is True
    assert verification["total_entries"] > 150
    assert len(client.get("/api/audit", headers=admin).json()) > 0
