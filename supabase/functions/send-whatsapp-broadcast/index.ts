// send-whatsapp-broadcast — sends the next batch of a queued WhatsApp
// broadcast via the Meta WhatsApp Cloud API.
//
// DEPLOYMENT (run once you have a live Supabase project + WhatsApp
// Business Cloud API access):
//   1. Get a permanent access token + phone_number_id from Meta Business
//      Manager (developers.facebook.com/apps -> your app -> WhatsApp ->
//      API Setup / System Users).
//   2. From the project root:
//        npx supabase secrets set WHATSAPP_TOKEN=xxxx WHATSAPP_PHONE_NUMBER_ID=xxxx
//        npx supabase functions deploy send-whatsapp-broadcast
//   3. Call it from the app via lpgCloud.callFunction("send-whatsapp-broadcast",
//      { broadcast_id, limit }) — see js/broadcast.js.
//
// Only 'owner' and 'manager' roles may trigger a send; this is checked
// against the CALLER's own JWT (not trusted client input) before any
// message goes out. All DB writes after that use the service role key
// so RLS doesn't block cross-user updates to the recipient queue.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WHATSAPP_API_VERSION = "v20.0";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  const authHeader = req.headers.get("Authorization") || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const waToken = Deno.env.get("WHATSAPP_TOKEN");
  const waPhoneId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

  if (!waToken || !waPhoneId) {
    return new Response(
      JSON.stringify({ error: "WhatsApp credentials not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)." }),
      { status: 500 }
    );
  }

  // Client scoped to the caller's own JWT — used only to verify who's asking.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "Sign in first." }), { status: 401 });
  }
  const { data: profile } = await callerClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!profile || !["owner", "manager"].includes(profile.role)) {
    return new Response(JSON.stringify({ error: "Only Owner/Manager can send broadcasts." }), { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const broadcastId = body.broadcast_id;
  const limit = Math.min(Number(body.limit) || 250, 250); // Meta's new-number tier default
  if (!broadcastId) {
    return new Response(JSON.stringify({ error: "broadcast_id is required." }), { status: 400 });
  }

  // Service-role client for the actual queue processing.
  const db = createClient(supabaseUrl, serviceKey);

  const { data: broadcast, error: bErr } = await db
    .from("whatsapp_broadcasts")
    .select("*, whatsapp_templates(name, language, param_count)")
    .eq("id", broadcastId)
    .maybeSingle();
  if (bErr || !broadcast) {
    return new Response(JSON.stringify({ error: "Broadcast not found." }), { status: 404 });
  }
  const template = broadcast.whatsapp_templates;
  if (!template) {
    return new Response(JSON.stringify({ error: "Broadcast has no template." }), { status: 400 });
  }

  const { data: recipients, error: rErr } = await db
    .from("broadcast_recipients")
    .select("id, customer_id, customers(phone, opted_out)")
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending")
    .limit(limit);
  if (rErr) {
    return new Response(JSON.stringify({ error: rErr.message }), { status: 500 });
  }

  const params: string[] = [];
  for (let i = 1; i <= (template.param_count || 0); i++) {
    params.push(String((broadcast.param_values || {})[String(i)] || ""));
  }

  let sent = 0;
  let failed = 0;

  for (const r of recipients || []) {
    const customer = (r as any).customers;
    if (!customer || !customer.phone) {
      await db.from("broadcast_recipients").update({ status: "skipped", error: "no phone" }).eq("id", r.id);
      continue;
    }
    if (customer.opted_out) {
      await db.from("broadcast_recipients").update({ status: "skipped", error: "opted out" }).eq("id", r.id);
      continue;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: customer.phone,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language || "en" },
        ...(params.length
          ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: p })) }] }
          : {}),
      },
    };

    try {
      const resp = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${waPhoneId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${waToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await resp.json();
      if (resp.ok && json.messages?.[0]?.id) {
        await db
          .from("broadcast_recipients")
          .update({ status: "sent", wa_message_id: json.messages[0].id, sent_at: new Date().toISOString() })
          .eq("id", r.id);
        sent++;
      } else {
        await db
          .from("broadcast_recipients")
          .update({ status: "failed", error: JSON.stringify(json.error || json) })
          .eq("id", r.id);
        failed++;
      }
    } catch (err) {
      await db.from("broadcast_recipients").update({ status: "failed", error: String(err) }).eq("id", r.id);
      failed++;
    }

    // Gentle pacing — well under Meta's default throughput limits.
    await new Promise((res) => setTimeout(res, 150));
  }

  const { count: remaining } = await db
    .from("broadcast_recipients")
    .select("id", { count: "exact", head: true })
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending");

  await db
    .from("whatsapp_broadcasts")
    .update({
      sent_count: (broadcast.sent_count || 0) + sent,
      failed_count: (broadcast.failed_count || 0) + failed,
      status: remaining && remaining > 0 ? "sending" : "completed",
    })
    .eq("id", broadcastId);

  return new Response(JSON.stringify({ sent, failed, remaining: remaining || 0 }), {
    headers: { "Content-Type": "application/json" },
  });
});
