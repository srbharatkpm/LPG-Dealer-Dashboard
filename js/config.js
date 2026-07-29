// Fill these in once the Supabase project for LPG Dealer Accounts exists.
// Supabase dashboard -> Project Settings -> API -> Project URL / anon public key.
// The anon key is safe to ship client-side; access control is enforced by
// Row Level Security policies in db/schema.sql, not by hiding this key.
window.LPG_CONFIG = {
  SUPABASE_URL: "https://gaacsvsadghhhsoiraxc.supabase.co",
  // sb_publishable key (new Supabase API-key system; the project's legacy
  // JWT-style anon key was disabled). Public by design — RLS is the gate.
  SUPABASE_ANON_KEY: "sb_publishable_uJOReMR1ywTLdre6NLtYnw_PpUMyF9a",
};
