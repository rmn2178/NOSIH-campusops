// Grok for text understanding. No embeddings — duplicate detection is trigram
// based in the database. Every stage has a deterministic fallback so intake
// never fails without a key.

const LLM_KEY = Deno.env.get("XAI_API_KEY") ?? "";
// A `gsk_` key is a Groq key; anything else is treated as an x.ai Grok key.
const IS_GROQ = LLM_KEY.startsWith("gsk_");
const LLM_ENDPOINT = IS_GROQ
  ? "https://api.groq.com/openai/v1/chat/completions"
  : "https://api.x.ai/v1/chat/completions";
const LLM_MODEL =
  Deno.env.get("GROK_MODEL") ?? (IS_GROQ ? "openai/gpt-oss-120b" : "grok-4-fast");

const SAFETY_WORDS = ["spark", "sparks", "smoke", "fire", "burning", "shock", "short circuit", "live wire"];
const HARMFUL_WORDS = ["kill", "hurt", "attack", "threaten", "threat", "acid", "weapon"];
const ABUSIVE_WORDS = ["idiot", "stupid", "useless", "incompetent", "moron", "bastard", "damn"];

export type Moderation = {
  status: "APPROVED" | "NEEDS_REWRITE" | "HELD_ABUSIVE" | "HELD_HARMFUL";
  reason: string;
  rewrite: string | null;
};

export type Extracted = {
  space_code: string | null;
  target_assets: Array<{ asset_type: string; asset_codes: string[] }>;
  missing_info_questions: string[];
  affects_active_class: boolean;
  severity_indicators: string[];
};

export type Classification = {
  category: string;
  required_skill: string;
  required_risk_clearance: string;
  urgency: string;
};

async function grokJson(system: string, prompt: string): Promise<Record<string, unknown> | null> {
  if (!LLM_KEY) return null;
  try {
    const response = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    const text: string = payload.choices?.[0]?.message?.content ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < 0) return null;
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export async function moderate(text: string): Promise<Moderation> {
  const llm = await grokJson(
    "You moderate a university facilities complaint feed. Return JSON only: {\"status\":\"APPROVED|NEEDS_REWRITE|HELD_ABUSIVE|HELD_HARMFUL\",\"reason\":\"short reason\",\"rewrite\":\"polite factual rewrite or null\"}. Keep every room code and asset detail in a rewrite.",
    text,
  );

  const lowered = text.toLowerCase();
  if (llm && typeof llm.status === "string") {
    return {
      status: llm.status as Moderation["status"],
      reason: String(llm.reason ?? "Moderated"),
      rewrite: llm.rewrite ? String(llm.rewrite) : null,
    };
  }

  if (HARMFUL_WORDS.some((word) => lowered.includes(word))) {
    return {
      status: "HELD_HARMFUL",
      reason: "Threat or harmful content detected",
      rewrite: null,
    };
  }
  if (ABUSIVE_WORDS.some((word) => lowered.includes(word))) {
    return {
      status: "NEEDS_REWRITE",
      reason: "Personal attacks or abusive language detected",
      rewrite: text
        .replace(/\b(idiot|stupid|useless|incompetent|moron|bastard|damn)\b/gi, "")
        .replace(/\s+/g, " ")
        .trim(),
    };
  }
  return { status: "APPROVED", reason: "No policy violation detected", rewrite: null };
}

const ASSET_PATTERNS: Array<[string, RegExp, string, number]> = [
  ["SMART_BOARD", /smart\s*board|projector|display|screen/i, "SB", 1],
  ["CEILING_FAN", /fans?|ceiling\s*fans?/i, "FAN", 9],
  ["LED_LIGHT", /leds?|lights?|tube\s*lights?/i, "LED", 12],
  ["LAB_WORKSTATION", /lab\s+(?:instrument|equipment|workstation)|oscilloscope|microscope/i, "INST", 15],
  ["CANTEEN_APPLIANCE", /stove|oven|refrigerator|fridge|coffee\s*machine|food\s*warmer/i, "APPL", 4],
  ["BILL_BOT_MECHANISM", /bill\s*bot|printer|thermal\s*head|paper\s*jam/i, "MECH", 1],
];

export function resolveSpace(text: string, selected?: string | null): string | null {
  if (selected) return selected.toUpperCase();
  const direct = text.match(/\b([ABC])(\d)-0?([1-6])\b/i);
  if (direct) {
    const floor = direct[2] === "0" ? 1 : Number(direct[2]);
    return `${direct[1].toUpperCase()}${floor}-0${direct[3]}`;
  }
  const lab = text.match(/\b(chem(?:istry)?|phys(?:ics)?|oops|dbms|mech|ece)\s+lab\s+(\d{1,2})\b/i);
  if (lab) {
    const prefixes: Record<string, string> = {
      chem: "CHEM", chemistry: "CHEM", phys: "PHYS", physics: "PHYS",
      oops: "OOPS", dbms: "DBMS", mech: "MECH", ece: "ECE",
    };
    return `LAB-${prefixes[lab[1].toLowerCase()]}-${String(Number(lab[2])).padStart(2, "0")}`;
  }
  if (/chai\s+kings/i.test(text)) return "CAN-05";
  const canteens: Array<[RegExp, string]> = [
    [/cafe tea/i, "CAN-01"], [/bakery/i, "CAN-02"],
    [/breakfast counter/i, "CAN-03"], [/lunch hall/i, "CAN-04"],
  ];
  for (const [pattern, code] of canteens) if (pattern.test(text)) return code;
  const bot = text.match(/\bbill\s*bot\s*(\d{1,2})\b/i);
  if (bot) return `BOT-${String(Number(bot[1])).padStart(2, "0")}`;
  return null;
}

export async function extract(text: string, selected?: string | null): Promise<Extracted> {
  const llm = await grokJson(
    "Extract facilities entities. Return JSON only with space_code, target_assets (array of {asset_type, asset_codes}), missing_info_questions (max 3), affects_active_class (boolean), severity_indicators (array). Preserve exact room and unit numbers.",
    text,
  );

  const space = (llm?.space_code as string | undefined) ?? resolveSpace(text, selected);
  let targetAssets: Extracted["target_assets"] = [];

  if (Array.isArray(llm?.target_assets)) {
    targetAssets = (llm!.target_assets as Array<Record<string, unknown>>).map((asset) => ({
      asset_type: String(asset.asset_type ?? ""),
      asset_codes: Array.isArray(asset.asset_codes) ? asset.asset_codes.map(String) : [],
    })).filter((asset) => asset.asset_type && asset.asset_codes.length > 0);
  }

  if (targetAssets.length === 0) {
    for (const [assetType, pattern, prefix, maximum] of ASSET_PATTERNS) {
      if (!pattern.test(text)) continue;
      const codes: string[] = [];
      if (space) {
        const numbers = text.match(/(?:fans?|lights?|leds?|units?)\s*(?:numbers?|nos?\.?|#)?\s*([\d\s,and]+)/i);
        const parsed = numbers
          ? [...numbers[1].matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n >= 1 && n <= maximum)
          : [];
        const indices = parsed.length > 0
          ? [...new Set(parsed)]
          : assetType === "CEILING_FAN" || assetType === "LED_LIGHT"
            ? [1, 2, 3, 4]
            : [1];
        for (const index of indices) {
          codes.push(`${prefix}-${space}-${String(index).padStart(2, "0")}`);
        }
      }
      targetAssets.push({ asset_type: assetType, asset_codes: codes });
    }
  }

  const questions = Array.isArray(llm?.missing_info_questions)
    ? (llm!.missing_info_questions as unknown[]).map(String).slice(0, 3)
    : [];
  if (questions.length === 0) {
    if (targetAssets.some((asset) => asset.asset_type === "SMART_BOARD")) {
      questions.push("Is the Smart Board completely black, or flickering?");
    }
    if (targetAssets.some((asset) => asset.asset_type === "CEILING_FAN") && !/\bfans?\s*(?:numbers?|nos?\.?|#)?\s*\d/i.test(text)) {
      questions.push("Which fan numbers are affected?");
    }
    if (!/spark|smoke|fire|burning|shock|short circuit/i.test(text)) {
      questions.push("Is there any burning smell, smoke, sparking, or electric shock?");
    }
  }

  const severity = SAFETY_WORDS.filter((word) => text.toLowerCase().includes(word));
  return {
    space_code: space,
    target_assets: targetAssets,
    missing_info_questions: questions.slice(0, 3),
    affects_active_class: llm?.affects_active_class === true || /\b(class|students?|lecture|session)\b/i.test(text),
    severity_indicators: Array.isArray(llm?.severity_indicators)
      ? (llm!.severity_indicators as unknown[]).map(String)
      : severity,
  };
}

export async function classify(text: string, extracted: Extracted): Promise<Classification> {
  const llm = await grokJson(
    "Classify a campus fault. Return JSON only with category, required_skill, required_risk_clearance, urgency. Safety hazards are always CRITICAL SAFETY_FIRE with HIGH_VOLTAGE.",
    text,
  );
  const lowered = text.toLowerCase();
  const assetTypes = new Set(extracted.target_assets.map((asset) => asset.asset_type));

  let result: Classification;
  if (assetTypes.has("BILL_BOT_MECHANISM") || lowered.includes("bill bot")) {
    result = { category: "BILL_BOT", required_skill: "IT_AV", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else if (assetTypes.has("CANTEEN_APPLIANCE")) {
    result = { category: "CANTEEN_APPLIANCE", required_skill: "ELECTRICAL", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else if (assetTypes.has("SMART_BOARD")) {
    result = { category: "IT_SMARTBOARD", required_skill: "IT_AV", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else if (assetTypes.has("CEILING_FAN") || /ac\b|hvac|air conditioner/.test(lowered)) {
    result = { category: "FANS_HVAC", required_skill: /hvac|air conditioner/.test(lowered) ? "HVAC" : "ELECTRICAL", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else if (assetTypes.has("LAB_WORKSTATION")) {
    result = { category: "LAB_EQUIPMENT", required_skill: "LAB_SUPPORT", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else if (/water|leak|pipe|tap|drain/.test(lowered)) {
    result = { category: "PLUMBING", required_skill: "PLUMBING", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else if (/desk|chair|door|furniture/.test(lowered)) {
    result = { category: "FURNITURE", required_skill: "CARPENTRY", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else if (/dirty|garbage|clean|waste/.test(lowered)) {
    result = { category: "CLEANLINESS", required_skill: "LAB_SUPPORT", required_risk_clearance: "STANDARD", urgency: "MEDIUM" };
  } else {
    result = { category: "ELECTRICAL", required_skill: "ELECTRICAL", required_risk_clearance: "HIGH_VOLTAGE", urgency: "MEDIUM" };
  }

  if (llm) {
    for (const key of ["category", "required_skill", "required_risk_clearance", "urgency"] as const) {
      if (typeof llm[key] === "string") result[key] = String(llm[key]);
    }
  }

  if (/not working at all|total failure|flooding/.test(lowered) || assetTypes.size > 1) {
    result.urgency = "HIGH";
  }
  if (SAFETY_WORDS.some((word) => lowered.includes(word))) {
    result = { category: "SAFETY_FIRE", required_skill: "ELECTRICAL", required_risk_clearance: "HIGH_VOLTAGE", urgency: "CRITICAL" };
  }
  return result;
}
