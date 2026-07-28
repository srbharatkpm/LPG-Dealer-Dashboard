// create-team-user — lets the Owner create a staff login directly,
// instead of the staff member signing up and waiting to be assigned.
//
// Staff log in with their MOBILE NUMBER, not an email. Supabase Auth
// needs an email identifier, so the mobile is turned into a synthetic
// one (9876543210 -> 9876543210@srbharatgas.local). Nothing is ever
// sent to it — the account is created pre-confirmed. This avoids
// needing an SMS provider just to issue logins.
//
// DEPLOY:
//   npx supabase functions deploy create-team-user
// SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL are injected automatically;
// no extra secrets needed.

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const EMAIL_DOMAIN = "srbharatgas.local";
const ASSIGNABLE = ["manager", "accounts", "staff", "driver", "pending"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Who is asking? Checked against their own JWT, never trusted from the body.
  const caller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Sign in first." }, 401);

  const { data: callerProfile } = await caller
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!callerProfile || !["owner", "manager"].includes(callerProfile.role)) {
    return json({ error: "Only the owner or a manager can create users." }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const full_name = String(body.full_name || "").trim();
  const mobile = String(body.mobile || "").replace(/\D/g, "").slice(-10);
  const role = String(body.role || "pending");
  const password = String(body.password || "");
  const vehicle_number = String(body.vehicle_number || "").trim() || null;
  const line = String(body.line || "").trim() || null;

  if (!full_name) return json({ error: "Name is required." }, 400);
  if (mobile.length !== 10) return json({ error: "Mobile number must be 10 digits." }, 400);
  if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
  // Owner is pinned to a single email in the database; it is not something
  // this endpoint can hand out, however the request is shaped.
  if (!ASSIGNABLE.includes(role)) return json({ error: "That role cannot be assigned here." }, 400);

  const email = `${mobile}@${EMAIL_DOMAIN}`;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name, phone: mobile, vehicle_number, line },
  });
  if (createErr) {
    const msg = /already/i.test(createErr.message)
      ? `A login already exists for ${mobile}.`
      : createErr.message;
    return json({ error: msg }, 400);
  }

  const { error: profErr } = await admin.from("profiles").insert({
    id: created.user.id,
    role,
    full_name,
    phone: mobile,
    vehicle_number,
    line,
  });
  if (profErr) {
    // Don't leave a signin-able account with no profile behind.
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: profErr.message }, 400);
  }

  return json({ ok: true, mobile, role, full_name });
});
