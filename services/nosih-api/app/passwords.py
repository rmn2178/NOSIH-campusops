"""Password hashing for command-portal accounts.

PBKDF2-HMAC-SHA256 with a per-account salt. The salt is the normalised email so
seed runs stay byte-for-byte deterministic while hashes remain account-specific.
"""

from __future__ import annotations

import hashlib
import hmac

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 120_000


def hash_password(password: str, salt: str) -> str:
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.strip().lower().encode("utf-8"), ITERATIONS)
    return f"{ALGORITHM}${ITERATIONS}${digest.hex()}"


def verify_password(password: str, encoded: str | None, salt: str) -> bool:
    if not encoded:
        return False
    try:
        algorithm, iterations, digest_hex = encoded.split("$", 2)
        expected = bytes.fromhex(digest_hex)
    except ValueError:
        return False
    if algorithm != ALGORITHM:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.strip().lower().encode("utf-8"), int(iterations))
    return hmac.compare_digest(actual, expected)
