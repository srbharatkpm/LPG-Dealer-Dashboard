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
    // Details go into auth user_metadata rather than straight into
    // `profiles`, because with email confirmation switched on signUp
    // returns a user but NO session — an insert at this point would run
    // as `anon` and be refused. ensureProfile() creates the row later,
    // on the first request that actually has a session.
    //
    // Note there is no role here: the database decides it (first signup
    // becomes the owner, everyone after lands on 'pending'), so there is
    // nothing a crafted request from this public page could claim.
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: profile.full_name,
          phone: profile.phone || null,
          vehicle_number: profile.vehicle_number || null,
          line: profile.line || null,
        },
      },
    });
    if (error) throw error;

    if (!data.session) return { needsConfirmation: true };

    await ensureProfile();
    return { needsConfirmation: false };
  }

  // Creates this user's `profiles` row from their signup metadata if it
  // doesn't exist yet. Safe to call on every sign-in; it's a no-op once
  // the row is there. The 'pending' sent here is a placeholder to satisfy
  // NOT NULL — the bootstrap_first_owner() trigger overwrites it.
  async function ensureProfile() {
    const sb = client_();
    const session = await getSession();
    if (!session) return null;

    const existing = await getProfile();
    if (existing) return existing;

    const meta = session.user.user_metadata || {};
    const { data, error } = await sb
      .from("profiles")
      .insert({
        id: session.user.id,
        role: "pending",
        full_name: meta.full_name || session.user.email,
        phone: meta.phone || null,
        vehicle_number: meta.vehicle_number || null,
        line: meta.line || null,
      })
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function signIn(email, password) {
    const sb = client_();
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await ensureProfile();
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

  // ---- offline write cache -------------------------------------------
  // If a save fails because the device is offline (patchy mobile signal
  // at the godown / on delivery rounds), the write is kept in
  // localStorage and replayed into the real tables as soon as the
  // connection returns. Only inserts/upserts queue — updates and
  // deletes are rare on the road and fail loudly instead.
  const QUEUE_KEY = "lpg_offline_queue";

  function isNetworkError(err) {
    return (
      err instanceof TypeError ||
      /failed to fetch|network|load failed/i.test(String(err && err.message))
    );
  }

  function readQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch (_) {
      return [];
    }
  }

  function writeQueue(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  }

  function enqueue(op, table, rows, onConflict) {
    const q = readQueue();
    q.push({ op, table, rows, onConflict: onConflict || null, ts: Date.now() });
    writeQueue(q);
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing) return;
    const q = readQueue();
    if (!q.length) return;
    flushing = true;
    try {
      const sb = client_();
      while (q.length) {
        const item = q[0];
        const query =
          item.op === "upsert"
            ? sb.from(item.table).upsert(item.rows, { onConflict: item.onConflict })
            : sb.from(item.table).insert(item.rows);
        const { error } = await query;
        // Data errors (RLS, constraint) will never succeed on retry —
        // drop those rather than jamming the queue forever. Network
        // errors keep the item for the next attempt.
        if (error && isNetworkError(error)) break;
        q.shift();
        writeQueue(q);
      }
    } catch (err) {
      if (!isNetworkError(err)) {
        q.shift();
        writeQueue(q);
      }
    } finally {
      flushing = false;
    }
  }

  window.addEventListener("online", flushQueue);
  // also try shortly after page load, once a session likely exists
  setTimeout(() => flushQueue().catch(() => {}), 4000);

  function pendingOfflineCount() {
    return readQueue().length;
  }
  // --------------------------------------------------------------------

  // Pages through a large table 1000 rows at a time (PostgREST caps a
  // single response at 1000). Needed for `customers` — the BPCL master
  // has ~25k consumers, and a plain select would silently truncate.
  async function selectAll(table, opts = {}) {
    const sb = client_();
    const page = 1000;
    let from = 0;
    const all = [];
    for (;;) {
      let q = sb.from(table).select(opts.columns || "*").range(from, from + page - 1);
      if (opts.eq) for (const [c, v] of Object.entries(opts.eq)) q = q.eq(c, v);
      const { data, error } = await q;
      if (error) throw error;
      all.push.apply(all, data);
      if (data.length < page) break;
      from += page;
    }
    return all;
  }

  async function insert(table, rows) {
    const sb = client_();
    try {
      const { data, error } = await sb.from(table).insert(rows).select();
      if (error) throw error;
      return data;
    } catch (err) {
      if (isNetworkError(err)) {
        enqueue("insert", table, rows, null);
        return rows; // treated as saved; it syncs when back online
      }
      throw err;
    }
  }

  async function upsert(table, rows, onConflict) {
    const sb = client_();
    try {
      const { data, error } = await sb.from(table).upsert(rows, { onConflict }).select();
      if (error) throw error;
      return data;
    } catch (err) {
      if (isNetworkError(err)) {
        enqueue("upsert", table, rows, onConflict);
        return rows;
      }
      throw err;
    }
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
    if (error) {
      // supabase-js hides the response behind error.context and throws a
      // generic "non-2xx status code" — dig the actual message out so the
      // user sees WHY (not signed in / not owner / bad input / gateway).
      if (error.context && typeof error.context.text === "function") {
        let detail = "";
        try {
          detail = await error.context.text();
        } catch (_) { /* body unreadable; fall through */ }
        try {
          const j = JSON.parse(detail);
          detail = j.error || j.message || detail;
        } catch (_) { /* not JSON; use raw text */ }
        if (detail) throw new Error(detail);
      }
      throw error;
    }
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
    selectAll,
    insert,
    upsert,
    update,
    remove,
    callFunction,
    flushQueue,
    pendingOfflineCount,
  };
})();
