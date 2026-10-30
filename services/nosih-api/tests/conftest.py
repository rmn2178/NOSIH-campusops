"""Test environment defaults.

The suite must pass on a clean checkout and in CI, where no `.env` exists.
The identity-vault key is generated per run; it is test-only and never used by
any deployment.
"""

import os

from cryptography.fernet import Fernet

os.environ.setdefault("IDENTITY_VAULT_FERNET_KEY", Fernet.generate_key().decode())
os.environ.setdefault("JWT_SECRET", "nosih-test-secret-0123456789abcdef0123456789")
os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")
