"""Create the PGP secret used by the identity vault, inside Supabase Vault."""

from __future__ import annotations

import secrets
import sys

from sqlalchemy import text

sys.path.insert(0, ".")

from app.database import engine  # noqa: E402


def main() -> None:
    with engine.connect() as conn:
        existing = conn.execute(
            text("select count(*) from vault.decrypted_secrets where name = 'nosih_vault_secret'")
        ).scalar_one()
        if existing:
            print("vault secret already present")
            return
        secret = secrets.token_urlsafe(48)
        conn.execute(
            text("select vault.create_secret(:secret, 'nosih_vault_secret', 'NOSIH identity vault PGP key')"),
            {"secret": secret},
        )
        conn.commit()
        print("vault secret created")


if __name__ == "__main__":
    main()
