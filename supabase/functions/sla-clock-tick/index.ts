import { corsHeaders, json } from "../_shared/cors.ts";
import { admin } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const expected = Deno.env.get("CRON_SECRET") ?? "";
  const provided = req.headers.get("x-cron-secret") ?? "";
  if (!expected || provided !== expected) return json({ error: "UNAUTHORIZED" }, 401);

  try {
    const { data, error } = await admin.rpc("rpc_tick_sla_clocks");
    if (error) return json({ error: error.message }, 400);
    return json(data);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
