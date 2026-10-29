import json
import urllib.request
from typing import Any

from app.config import settings


def complete_json(system: str, prompt: str) -> dict[str, Any] | None:
    if not settings.anthropic_api_key and not settings.openai_api_key:
        return None
    if settings.anthropic_api_key:
        request = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps({"model": "claude-3-5-haiku-latest", "max_tokens": 1000, "system": system, "messages": [{"role": "user", "content": prompt}]}).encode(),
            headers={"x-api-key": settings.anthropic_api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        )
    else:
        request = urllib.request.Request(
            "https://api.openai.com/v1/chat/completions",
            data=json.dumps({"model": "gpt-4o-mini", "response_format": {"type": "json_object"}, "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]}).encode(),
            headers={"Authorization": f"Bearer {settings.openai_api_key}", "content-type": "application/json"},
        )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = json.loads(response.read())
        text = payload["content"][0]["text"] if "content" in payload else payload["choices"][0]["message"]["content"]
        start, end = text.find("{"), text.rfind("}") + 1
        parsed = json.loads(text[start:end])
        return parsed if isinstance(parsed, dict) else None
    except (OSError, ValueError, KeyError, IndexError):
        return None
