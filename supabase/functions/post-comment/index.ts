import { corsHeaders, json } from "../_shared/cors.ts";
import { moderate } from "../_shared/ai.ts";
import { admin } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "UNAUTHORIZED" }, 401);

    const { data: profile } = await admin
      .from("users")
      .select("email, role")
      .eq("auth_user_id", userData.user.id)
      .maybeSingle();
    if (!profile) return json({ error: "PROFILE_NOT_FOUND" }, 404);

    const body = await req.json();
    if (!body?.complaint_id || !body?.body) {
      return json({ error: "COMPLAINT_AND_BODY_REQUIRED" }, 422);
    }

    const moderation = await moderate(String(body.body));
    if (moderation.status === "HELD_ABUSIVE" || moderation.status === "HELD_HARMFUL") {
      return json({
        moderation_status: moderation.status,
        message: "This comment was withheld by the moderation policy.",
      }, 200);
    }

    const { data, error } = await admin.rpc("rpc_post_comment", {
      p_payload: {
        complaint_id: Number(body.complaint_id),
        email: profile.email,
        body: String(body.body),
        is_anonymous: Boolean(body.is_anonymous),
        moderation_status: moderation.status === "NEEDS_REWRITE" ? "NEEDS_REWRITE" : "APPROVED",
        suggested_rewrite: moderation.rewrite,
      },
    });
    if (error) return json({ error: error.message }, 400);

    return json(data);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
