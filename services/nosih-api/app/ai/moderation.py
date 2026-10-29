import re
from dataclasses import dataclass

from app.ai.llm import complete_json


@dataclass(frozen=True)
class ModerationResult:
    status: str
    reason: str
    suggested_polite_rewrite: str | None = None


HARMFUL_PATTERNS = (
    r"\b(i will|we will|going to)\s+(kill|hurt|attack|bomb)\b",
    r"\bdeath threat\b",
    r"\bmake a bomb\b",
)
ABUSIVE_PATTERNS = (
    r"\b(fuck|fucking|bullshit|shit|crap|bitch|bastard|asshole|moron|idiot|dumbass|damn|useless|stupid)\b",
)
FACILITIES_WORDS = re.compile(r"\b(fan|light|board|room|lab|projector|water|leak|pipe|canteen|bot|bill|toilet|desk|chair|power|electric)\b", re.I)


def polite_rewrite(text: str) -> str:
    cleaned = re.sub(r"\b(what a|useless college|damn|fucking|fuck|shit|stupid|idiot|useless)\b", "", text, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,!.")
    cleaned = re.sub(r"\b(dead|not working again)\b", "not working", cleaned, flags=re.I)
    cleaned = re.sub(r"\bwe are sweating\b", "making the room uncomfortably warm during class", cleaned, flags=re.I)
    if not cleaned:
        return "Please investigate this campus facilities issue."
    return cleaned[0].upper() + cleaned[1:] + ("." if not cleaned.endswith(".") else "")


def moderate_content(text: str) -> ModerationResult:
    llm = complete_json(
        "Moderate campus facilities content. Return JSON with status APPROVED, NEEDS_REWRITE, HELD_ABUSIVE, or HELD_HARMFUL, a reason, and suggested_polite_rewrite when relevant. Never permit threats, slurs, defamation, or targeted harassment.",
        text,
    )
    if llm and llm.get("status") in {"APPROVED", "NEEDS_REWRITE", "HELD_ABUSIVE", "HELD_HARMFUL"}:
        return ModerationResult(llm["status"], str(llm.get("reason", "Moderated by AI")), llm.get("suggested_polite_rewrite"))
    normalized = text.lower()
    if any(re.search(pattern, normalized, re.I) for pattern in HARMFUL_PATTERNS):
        return ModerationResult("HELD_HARMFUL", "Threatening or harmful content is held for private review.")
    abuse = any(re.search(pattern, normalized, re.I) for pattern in ABUSIVE_PATTERNS)
    targeted = bool(re.search(r"\b(mr|ms|mrs|dr|professor)\.?\s+[a-z]+\b.{0,50}\b(stupid|idiot|useless|corrupt)\b", normalized, re.I))
    if targeted or (abuse and not FACILITIES_WORDS.search(text)):
        return ModerationResult("HELD_ABUSIVE", "Targeted or abusive content is held for private review.")
    if abuse:
        return ModerationResult("NEEDS_REWRITE", "The report contains frustration that can be expressed respectfully.", polite_rewrite(text))
    if re.search(r"\b(https?://\S+).*\1", normalized, re.I) or len(set(normalized.split())) < max(2, len(normalized.split()) // 5):
        return ModerationResult("HELD_ABUSIVE", "Repetitive or malicious spam is held for private review.")
    return ModerationResult("APPROVED", "Clean facilities report")
