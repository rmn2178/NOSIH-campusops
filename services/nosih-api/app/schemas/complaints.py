from datetime import datetime

from pydantic import BaseModel, Field, field_validator


class ComplaintCreate(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    description: str = Field(min_length=10, max_length=5000)
    space_code: str
    space_type: str | None = None
    is_anonymous: bool = False
    image_url: str | None = None
    photo_upload_id: str | None = None
    target_assets: list[dict] = Field(default_factory=list)
    client_timestamp: datetime | None = None


class SupplementRequest(BaseModel):
    answers: dict[str, str] | list[dict[str, str]]

    @field_validator("answers")
    @classmethod
    def validate_answers(cls, answers: dict[str, str] | list[dict[str, str]]) -> dict[str, str] | list[dict[str, str]]:
        values = answers.values() if isinstance(answers, dict) else answers
        if not answers or any(not str(value).strip() for value in values):
            raise ValueError("Supplement answers cannot be empty")
        return answers

    def answer_map(self) -> dict[str, str]:
        if isinstance(self.answers, dict):
            return self.answers
        return {item["question"]: item["answer"] for item in self.answers}


class CommentCreate(BaseModel):
    body: str = Field(min_length=2, max_length=2000)
    is_anonymous: bool = False


class RewriteRequest(BaseModel):
    description: str = Field(min_length=10, max_length=5000)


class VaultUnsealRequest(BaseModel):
    justification_reason: str = Field(min_length=25, max_length=1000)
    policy_clause: str

    @field_validator("policy_clause")
    @classmethod
    def valid_policy(cls, value: str) -> str:
        if value not in {"THREAT_TO_LIFE_SAFETY", "SEVERE_HARASSMENT_INVESTIGATION"}:
            raise ValueError("Unsupported break-glass policy clause")
        return value
