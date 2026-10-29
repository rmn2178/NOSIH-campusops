import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import IdentityVault, User


def get_fernet(key: str | bytes | None = None) -> Fernet:
    configured = key or settings.identity_vault_fernet_key
    if not configured:
        raise RuntimeError("IDENTITY_VAULT_FERNET_KEY must be configured for anonymous submissions")
    return Fernet(configured.encode() if isinstance(configured, str) else configured)


def reporter_rate_limit_hash(user_id: int, key: str | bytes | None = None) -> str:
    configured = key or settings.identity_vault_fernet_key
    if not configured:
        raise RuntimeError("IDENTITY_VAULT_FERNET_KEY must be configured for anonymous submissions")
    secret = configured.encode() if isinstance(configured, str) else configured
    return hmac.new(secret, f"nosih-reporter:{user_id}".encode(), hashlib.sha256).hexdigest()


def seal_identity(user: User, client_timestamp: datetime | None = None) -> str:
    payload = {
        "user_id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "department_code": user.department_code,
        "year_number": user.year_number,
        "client_timestamp": (client_timestamp or datetime.now(timezone.utc)).isoformat(),
    }
    return get_fernet().encrypt(json.dumps(payload, separators=(",", ":")).encode()).decode()


def unseal_identity(encrypted_blob: str) -> dict[str, Any]:
    try:
        return json.loads(get_fernet().decrypt(encrypted_blob.encode()).decode())
    except (InvalidToken, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail="Identity vault payload cannot be decrypted") from exc


def public_identity_label(user: User, anonymous: bool) -> str:
    if not anonymous:
        year = f" • Year {user.year_number}" if user.year_number else ""
        return f"{user.full_name} • {user.department_code or user.role}{year}"
    if user.role == "STUDENT":
        return f"Anonymous Student • Year {user.year_number}"
    return "Anonymous Faculty/Staff"


def enforce_submission_rate_limit(db: Session, user: User) -> str:
    identity_hash = reporter_rate_limit_hash(user.id)
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=15)
    count = db.scalar(
        select(func.count(IdentityVault.id)).where(
            IdentityVault.reporter_rate_limit_hash == identity_hash,
            IdentityVault.created_at >= cutoff,
        )
    )
    if (count or 0) >= 5:
        raise HTTPException(status_code=429, detail="Maximum 5 anonymous submissions per 15 minutes")
    return identity_hash


def create_identity_vault(
    db: Session,
    *,
    user: User,
    target_entity_type: str,
    target_entity_id: int,
    client_timestamp: datetime | None = None,
) -> IdentityVault:
    record = IdentityVault(
        target_entity_type=target_entity_type,
        target_entity_id=target_entity_id,
        encrypted_identity_blob=seal_identity(user, client_timestamp),
        reporter_rate_limit_hash=enforce_submission_rate_limit(db, user),
    )
    db.add(record)
    db.flush()
    return record
