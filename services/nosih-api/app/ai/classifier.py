from typing import Any

from app.ai.llm import complete_json

SAFETY_WORDS = ("spark", "sparks", "smoke", "fire", "burning", "electric shock", "live wire", "short circuit")


def classify_fault(text: str, extracted: dict[str, Any]) -> dict[str, str]:
    llm = complete_json("Classify a campus fault as JSON with category, required_skill, required_risk_clearance, urgency. Safety hazards are always CRITICAL SAFETY_FIRE.", text)
    result = _classify_deterministic(text, extracted)
    if llm:
        for key in result:
            if llm.get(key):
                result[key] = str(llm[key])
    if any(word in text.lower() for word in SAFETY_WORDS):
        result.update(category="SAFETY_FIRE", required_skill="ELECTRICAL", required_risk_clearance="HIGH_VOLTAGE", urgency="CRITICAL")
    return result


def _classify_deterministic(text: str, extracted: dict[str, Any]) -> dict[str, str]:
    lowered = text.lower()
    asset_types = {asset["asset_type"] for asset in extracted.get("target_assets", [])}
    if "BILL_BOT_MECHANISM" in asset_types or "bill bot" in lowered:
        category, skill = "BILL_BOT", "IT_AV"
    elif "CANTEEN_APPLIANCE" in asset_types:
        category, skill = "CANTEEN_APPLIANCE", "ELECTRICAL"
    elif "SMART_BOARD" in asset_types:
        category, skill = "IT_SMARTBOARD", "IT_AV"
    elif "CEILING_FAN" in asset_types or any(word in lowered for word in ("ac ", "hvac", "air conditioner")):
        category, skill = "FANS_HVAC", "HVAC" if "hvac" in lowered or "air conditioner" in lowered else "ELECTRICAL"
    elif "LAB_WORKSTATION" in asset_types:
        category, skill = "LAB_EQUIPMENT", "LAB_SUPPORT"
    elif any(word in lowered for word in ("water", "leak", "pipe", "tap", "drain")):
        category, skill = "PLUMBING", "PLUMBING"
    elif any(word in lowered for word in ("desk", "chair", "door", "furniture")):
        category, skill = "FURNITURE", "CARPENTRY"
    elif any(word in lowered for word in ("dirty", "garbage", "clean", "waste")):
        category, skill = "CLEANLINESS", "LAB_SUPPORT"
    else:
        category, skill = "ELECTRICAL", "ELECTRICAL"
    urgency = "CRITICAL" if any(word in lowered for word in ("not working at all", "total failure", "flooding")) else "HIGH" if extracted.get("affects_active_class") or len(asset_types) > 1 else "MEDIUM"
    return {"category": category, "required_skill": skill, "required_risk_clearance": "STANDARD", "urgency": urgency}
