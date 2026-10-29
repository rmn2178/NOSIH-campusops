import re
from typing import Any

from app.ai.llm import complete_json

ASSET_PATTERNS = {
    "SMART_BOARD": (r"\b(smart\s*board|projector|display|screen)\b", "SB", 1),
    "CEILING_FAN": (r"\b(fans?|ceiling\s+fans?)\b", "FAN", 9),
    "LED_LIGHT": (r"\b(leds?|lights?|tube\s*lights?)\b", "LED", 12),
    "LAB_WORKSTATION": (r"\b(lab\s+(?:instrument|equipment|workstation)|oscilloscope|microscope)\b", "INST", 15),
    "CANTEEN_APPLIANCE": (r"\b(stove|oven|refrigerator|fridge|coffee\s+machine|food\s+warmer)\b", "APPL", 4),
    "BILL_BOT_MECHANISM": (r"\b(bill\s*bot|printer|thermal\s+head|paper\s+jam)\b", "MECH", 1),
}


def resolve_space_code(text: str, selected_space_code: str | None = None) -> str | None:
    if selected_space_code:
        return selected_space_code.upper()
    direct = re.search(r"\b([ABC])(\d)-0?([1-6])\b", text, re.I)
    if direct:
        block, floor, room = direct.groups()
        canonical_floor = 1 if floor == "0" else int(floor)
        return f"{block.upper()}{canonical_floor}-0{room}"
    natural = re.search(r"\b(first|second|third|fourth|fifth|sixth|seventh|\d)(?:st|nd|rd|th)?\s+floor\s+([ABC])(?:\s+block)?\s+room\s+(\d{1,2})\b", text, re.I)
    if natural:
        floor_names = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7}
        floor, block, room = natural.groups()
        floor_number = floor_names.get(floor.lower(), int(floor) if floor.isdigit() else 1)
        return f"{block.upper()}{floor_number}-{int(room):02d}"
    lab = re.search(r"\b(chem(?:istry)?|phys(?:ics)?|oops|dbms|mech|ece)\s+lab\s+(\d{1,2})\b", text, re.I)
    if lab:
        prefixes = {"chem": "CHEM", "chemistry": "CHEM", "phys": "PHYS", "physics": "PHYS", "oops": "OOPS", "dbms": "DBMS", "mech": "MECH", "ece": "ECE"}
        return f"LAB-{prefixes[lab.group(1).lower()]}-{int(lab.group(2)):02d}"
    if re.search(r"\bchai\s+kings\b", text, re.I):
        return "CAN-05"
    canteen_names = {"cafe tea": "CAN-01", "bakery": "CAN-02", "breakfast counter": "CAN-03", "lunch hall": "CAN-04"}
    for phrase, code in canteen_names.items():
        if phrase in text.lower():
            return code
    bot = re.search(r"\bbill\s*bot\s*(\d{1,2})\b", text, re.I)
    if bot:
        return f"BOT-{int(bot.group(1)):02d}"
    return None


def space_type_for(code: str | None) -> str:
    if not code:
        return "ROOM"
    if code.startswith("LAB-"):
        return "LAB"
    if code.startswith("CAN-"):
        return "CANTEEN"
    if code.startswith("BOT-"):
        return "BILL_BOT"
    return "ROOM"


def extract_entities(text: str, selected_space_code: str | None = None) -> dict[str, Any]:
    llm = complete_json("Extract campus fault entities as JSON with space_code, target_assets, severity_indicators, affects_active_class and missing_info_questions. Preserve exact room and asset numbers.", text)
    deterministic = _extract_deterministic(text, selected_space_code)
    if llm:
        deterministic.update({key: value for key, value in llm.items() if key in deterministic and value is not None})
    return deterministic


def _extract_deterministic(text: str, selected_space_code: str | None) -> dict[str, Any]:
    code = resolve_space_code(text, selected_space_code)
    targets: list[dict[str, Any]] = []
    for asset_type, (pattern, prefix, maximum) in ASSET_PATTERNS.items():
        match = re.search(pattern, text, re.I)
        if not match:
            continue
        indices: list[int] = []
        number_region = re.search(r"(?:fans?|lights?|leds?|units?)\s*(?:numbers?|nos?\.?|#)?\s*([\d\s,and]+)", text, re.I)
        if number_region:
            indices = sorted({int(value) for value in re.findall(r"\d+", number_region.group(1)) if 1 <= int(value) <= maximum})
        if not indices and asset_type == "CEILING_FAN" and re.search(r"\bfans\b", text, re.I):
            indices = [1, 2, 3, 4]
        if not indices:
            indices = [1]
        targets.append({"asset_type": asset_type, "indices": indices, "asset_codes": [f"{prefix}-{code}-{index:02d}" for index in indices] if code else []})
    questions: list[str] = []
    if any(item["asset_type"] == "SMART_BOARD" for item in targets):
        questions.extend(["Is the Smart Board display completely black or flickering?", "Is the HDMI input cable damaged?"])
    if any(item["asset_type"] == "CEILING_FAN" for item in targets) and not re.search(r"fans?\s+(?:numbers?|nos?\.?|#)?\s*\d", text, re.I):
        questions.append("Which fan numbers are affected?")
    if any(item["asset_type"] == "BILL_BOT_MECHANISM" for item in targets):
        questions.append("Is the printer jammed, out of paper, or not powering on?")
    if not re.search(r"\b(spark|smoke|fire|burning|shock|live wire|short circuit)\b", text, re.I):
        questions.append("Is there any burning smell, smoke, sparking, or electric shock?")
    indicators = [word for word in ("spark", "smoke", "fire", "burning", "shock", "flooding", "no power") if word in text.lower()]
    return {
        "space_code": code,
        "space_type": space_type_for(code),
        "target_assets": targets,
        "severity_indicators": indicators,
        "affects_active_class": bool(re.search(r"\b(class|students?|lecture|session)\b", text, re.I)),
        "missing_info_questions": questions[:3],
    }
