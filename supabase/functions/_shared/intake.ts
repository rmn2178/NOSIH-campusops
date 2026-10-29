import { classify, extract, moderate, resolveSpace } from "./ai.ts";

export type Profile = {
  email: string;
  full_name: string;
  role: string;
  department_code?: string | null;
  year_number?: number | null;
};

export type IntakeInput = {
  is_anonymous: boolean;
  space_code: string;
  description: string;
  image_url?: string | null;
  source_channel?: string;
};

export async function buildPayload(profile: Profile, input: IntakeInput) {
  const moderation = await moderate(input.description);
  const extracted = await extract(input.description, input.space_code);

  if (moderation.status !== "APPROVED") {
    return {
      ...profile,
      is_anonymous: input.is_anonymous,
      space_code: extracted.space_code ?? resolveSpace(input.description, input.space_code) ?? input.space_code,
      description: input.description,
      image_url: input.image_url ?? null,
      source_channel: input.source_channel ?? "WEB_PORTAL",
      target_assets: [],
      missing_info_questions: [],
      moderation_status: moderation.status,
      moderation_reason: moderation.reason,
      suggested_rewrite: moderation.rewrite,
    };
  }

  const classification = await classify(input.description, extracted);

  return {
    ...profile,
    is_anonymous: input.is_anonymous,
    space_code: extracted.space_code ?? resolveSpace(input.description, input.space_code) ?? input.space_code,
    description: input.description,
    image_url: input.image_url ?? null,
    source_channel: input.source_channel ?? "WEB_PORTAL",
    target_assets: extracted.target_assets,
    missing_info_questions: extracted.missing_info_questions,
    severity_indicators: extracted.severity_indicators,
    affects_active_class: extracted.affects_active_class,
    category: classification.category,
    required_skill: classification.required_skill,
    required_risk_clearance: classification.required_risk_clearance,
    urgency: classification.urgency,
    moderation_status: "APPROVED",
    moderation_reason: moderation.reason,
  };
}
