"""Load AI provider keys from supabase/functions/.env into Supabase Vault.

Server-side only: keys never touch browser env. Idempotent (upsert by name).
Usage: services/nosih-api/.venv/Scripts/python.exe scripts/load_ai_secrets.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / "supabase" / "functions" / ".env"

VAULT_NAMES = {
    "XAI_API_KEY": "xai_api_key",
    # Explicit model override; leave unset to let the provider default win.
    "LLM_MODEL": "llm_model",
}

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import settings  # noqa: E402


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def main() -> None:
    env = read_env()
    url = settings.database_url.replace("postgresql+psycopg://", "postgresql://")
    with psycopg.connect(url, autocommit=True) as conn:
        with conn.cursor() as cur:
            for env_key, vault_name in VAULT_NAMES.items():
                secret = env.get(env_key)
                if not secret:
                    print(f"skip {vault_name}: {env_key} not set in {ENV_FILE}")
                    continue
                cur.execute("select id from vault.secrets where name = %s", (vault_name,))
                row = cur.fetchone()
                if row:
                    cur.execute("select vault.update_secret(%s, %s)", (row[0], secret))
                else:
                    cur.execute(
                        "select vault.create_secret(%s, %s, %s)",
                        (secret, vault_name, f"NOSIH AI key ({env_key})"),
                    )
                print(f"stored {vault_name} ({len(secret)} chars)")
            cur.execute(
                "select name, length(decrypted_secret) from vault.decrypted_secrets "
                "where name = any(%s) order by name",
                (list(VAULT_NAMES.values()),),
            )
            for name, length in cur.fetchall():
                print(f"vault ok: {name} decrypts to {length} chars")


if __name__ == "__main__":
    main()
