import { corsHeaders, json } from "../_shared/cors.ts";
import { buildPayload } from "../_shared/intake.ts";
import { admin } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "UNAUTHORIZED" }, 401);

    const { data: profile, error: profileError } = await admin
      .from("users")
      .select("email, full_name, role, department_code, year_number")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (profileError || !profile) return json({ error: "PROFILE_NOT_FOUND" }, 404);

    const body = await req.json();
    if (!body?.space_code || !body?.description) {
      return json({ error: "SPACE_AND_DESCRIPTION_REQUIRED" }, 422);
    }

    const payload = await buildPayload(profile, {
      is_anonymous: Boolean(body.is_anonymous),
      space_code: String(body.space_code),
      description: String(body.description),
      image_url: body.image_url ?? null,
      source_channel: "WEB_PORTAL",
    });

    const { data, error } = await admin.rpc("rpc_submit_complaint", { p_payload: payload });
    if (error) return json({ error: error.message }, 400);

    return json(data);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
