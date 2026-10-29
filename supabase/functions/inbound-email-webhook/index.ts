import { corsHeaders, json } from "../_shared/cors.ts";
import { buildPayload } from "../_shared/intake.ts";
import { admin } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const expected = Deno.env.get("INBOUND_EMAIL_SECRET") ?? "";
  const provided = req.headers.get("x-nosih-secret") ?? "";
  if (!expected || provided !== expected) return json({ error: "UNAUTHORIZED" }, 401);

  try {
    const body = await req.json();
    const fromEmail = String(body?.from_email ?? "").toLowerCase();
    const description = `${body?.subject ?? ""}\n${body?.body ?? ""}`.trim();
    if (!fromEmail || description.length < 5) {
      return json({ error: "FROM_EMAIL_AND_BODY_REQUIRED" }, 422);
    }

    const { data: profile } = await admin
      .from("users")
      .select("email, full_name, role, department_code, year_number")
      .eq("email", fromEmail)
      .maybeSingle();

    const payload = await buildPayload(
      profile ?? {
        email: fromEmail,
        full_name: fromEmail.split("@")[0],
        role: "STUDENT",
        department_code: null,
        year_number: null,
      },
      {
        is_anonymous: false,
        space_code: String(body?.space_code ?? ""),
        description,
        source_channel: "EMAIL_INBOX",
      },
    );

    const { data, error } = await admin.rpc("rpc_submit_complaint", { p_payload: payload });
    if (error) return json({ error: error.message }, 400);

    const complaint = data?.complaint ?? {};
    await admin.from("notification_logs").insert({
      channel: "EMAIL",
      recipient: fromEmail,
      subject: `NOSIH received your report ${complaint.ticket_number ?? ""}`.trim(),
      payload_json: JSON.stringify({
        event: "EMAIL_INTAKE_ACK",
        complaint_id: complaint.id,
        ticket_number: complaint.ticket_number,
      }),
      delivery_status: "SENT",
      created_at: new Date().toISOString(),
    });

    return json({
      success: data?.success ?? false,
      complaint_id: complaint.id,
      ticket_number: complaint.ticket_number,
      moderation_status: data?.moderation_status,
    });
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});
