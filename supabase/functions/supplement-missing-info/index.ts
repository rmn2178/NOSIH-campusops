import { corsHeaders, json } from "../_shared/cors.ts";
import { admin } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    if (userError || !userData.user) return json({ error: "UNAUTHORIZED" }, 401);

    const body = await req.json();
    if (!body?.complaint_id || !body?.answers) {
      return json({ error: "COMPLAINT_AND_ANSWERS_REQUIRED" }, 422);
    }

    const { data, error } = await admin.rpc("rpc_supplement_complaint", {
      p_complaint_id: Number(body.complaint_id),
      p_answers: body.answers,
    });
    if (error) return json({ error: error.message }, 400);

    return json(data);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
