// Thin wrapper around Supabase for LPG Dealer Accounts.
// Requires js/config.js (window.LPG_CONFIG) and the supabase-js UMD script
// to be loaded before this file.

const lpgCloud = (() => {
  let client = null;

  function client_() {
    if (client) return client;
    const cfg = window.LPG_CONFIG || {};
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      throw new Error(
        "Supabase is not configured yet. Fill in js/config.js with your project URL and anon key."
      );
    }
    client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    return client;
  }

  async function signUp(email, password, profile) {
    const sb = client_();
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    const userId = data.user && data.user.id;
    if (!userId) {
      // Email confirmation required before session exists.
      return { needsConfirmation: true };
    }
    const { error: profErr } = await sb.from("profiles").insert({
      id: userId,
      role: profile.role,
      full_name: profile.full_name,
      phone: profile.phone || null,
      vehicle_number: profile.vehicle_number || null,
      line: profile.line || null,
    });
    if (profErr) throw profErr;
    return { needsConfirmation: false };
  }

  async function signIn(email, password) {
    const sb = client_();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async function signOut() {
    const sb = client_();
    await sb.auth.signOut();
  }

  async function getSession() {
    const sb = client_();
    const { data } = await sb.auth.getSession();
    return data.session;
  }

  async function getProfile() {
    const sb = client_();
    const session = await getSession();
    if (!session) return null;
    const { data, error } = await sb
      .from("profiles")
      .select("*")
      .eq("id", session.user.id)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  // Redirects to index.html if not signed in, or to index.html if role
  // doesn't match. expectedRole may be a single role string or an array
  // of allowed roles. Returns the profile on success.
  async function requireRole(expectedRole) {
    const allowed = Array.isArray(expectedRole) ? expectedRole : [expectedRole];
    const session = await getSession();
    if (!session) {
      window.location.href = "index.html";
      return null;
    }
    const profile = await getProfile();
    if (!profile || !allowed.includes(profile.role)) {
      window.location.href = "index.html";
      return null;
    }
    return profile;
  }

  async function select(table, opts = {}) {
    const sb = client_();
    let q = sb.from(table).select(opts.columns || "*");
    if (opts.eq) {
      for (const [col, val] of Object.entries(opts.eq)) q = q.eq(col, val);
    }
    if (opts.gte) {
      for (const [col, val] of Object.entries(opts.gte)) q = q.gte(col, val);
    }
    if (opts.lte) {
      for (const [col, val] of Object.entries(opts.lte)) q = q.lte(col, val);
    }
    if (opts.order) q = q.order(opts.order.column, { ascending: !!opts.order.ascending });
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }

  async function insert(table, rows) {
    const sb = client_();
    const { data, error } = await sb.from(table).insert(rows).select();
    if (error) throw error;
    return data;
  }

  async function upsert(table, rows, onConflict) {
    const sb = client_();
    const { data, error } = await sb.from(table).upsert(rows, { onConflict }).select();
    if (error) throw error;
    return data;
  }

  async function update(table, id, patch) {
    const sb = client_();
    const { data, error } = await sb.from(table).update(patch).eq("id", id).select();
    if (error) throw error;
    return data;
  }

  async function remove(table, id) {
    const sb = client_();
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw error;
  }

  async function callFunction(name, body) {
    const sb = client_();
    const { data, error } = await sb.functions.invoke(name, { body });
    if (error) throw error;
    return data;
  }

  return {
    client: client_,
    signUp,
    signIn,
    signOut,
    getSession,
    getProfile,
    requireRole,
    select,
    insert,
    upsert,
    update,
  };
})();
