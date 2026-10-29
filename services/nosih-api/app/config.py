from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "services/nosih-api/.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "sqlite:///./nosih.db"
    cors_origins: str = "http://localhost:5173,http://localhost:5174"
    identity_vault_fernet_key: str | None = None
    floor_index_mode: Literal["1-indexed", "0-indexed"] = "1-indexed"
    jwt_secret: str = "local-development-secret-change-me"
    jwt_expiry_hours: int = 12
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    upload_dir: str = "uploads"
    timetable_solver_seconds: float = 60.0

    # Supabase (new API key format: publishable / secret)
    supabase_url: str | None = None
    supabase_publishable_key: str | None = None
    supabase_secret_key: str | None = None
    supabase_service_role_key: str | None = None
    supabase_jwks_url: str | None = None
    supabase_storage_bucket: str = "complaint-evidence"

    # AI: Grok for text, Gemini for embeddings
    xai_api_key: str | None = None
    gemini_api_key: str | None = None
    grok_model: str = "grok-4.3"
    gemini_embed_model: str = "gemini-embedding-001"
    embedding_dims: int = 384

    @property
    def supabase_admin_key(self) -> str | None:
        return self.supabase_secret_key or self.supabase_service_role_key

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def cors_origin_regex(self) -> str:
        return r"https://[a-zA-Z0-9-]+\.vercel\.app"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
