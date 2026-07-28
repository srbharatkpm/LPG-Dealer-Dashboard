# Setup — LPG Dealer Accounts

Live app: https://srbharatkpm.github.io/LPG-Dealer-Dashboard/
Repo: https://github.com/srbharatkpm/LPG-Dealer-Dashboard
Supabase project: `gaacsvsadghhhsoiraxc`

Everything below is a one-time step. Ordering matters — the app has to
work before WhatsApp can be tested, because the Broadcast tab is only
visible to an Owner or Manager.

---

## 1. Database

Run the whole of [`db/schema.sql`](db/schema.sql) in the
[SQL Editor](https://supabase.com/dashboard/project/gaacsvsadghhhsoiraxc/sql/new).
It is safe to re-run: every statement is `if not exists` / `create or replace`.

That file also contains the `grant ...` block at the end. Without it every
query fails with `permission denied for table X` even for a correctly
signed-in user — Postgres checks table privileges *before* it evaluates
row-level security, and Supabase does not always apply its defaults to
tables created this way.

## 2. Auth settings

[Authentication → Providers → Email](https://supabase.com/dashboard/project/gaacsvsadghhhsoiraxc/auth/providers):
turn **Confirm email OFF**.

Supabase's built-in mailer allows only a couple of messages per hour, so
with confirmation on you hit `email rate limit exceeded` almost
immediately. This is an internal app where the owner hands out logins
directly, so the confirmation step buys nothing.

## 3. First account = Owner

Sign up on the live site. **The first account created becomes the Owner**,
so this must be you, before any staff sign up.

Everyone who signs up after that lands on `pending` with no access until
the Owner assigns them a role from the **Team** tab. Roles are decided by
a database trigger (`bootstrap_first_owner`), not by the signup form, so
the public URL cannot be used to claim Owner.

## 4. WhatsApp Business (optional, for customer broadcasts)

### Meta side

1. Meta Business account for SR Bharat Gas at business.facebook.com
2. **Business verification** — needs GST / incorporation documents. Until
   this is done the number is capped at **250 unique customers per 24h**.
3. App at developers.facebook.com/apps → type **Business** → add the
   **WhatsApp** product
4. **WhatsApp → API Setup** gives the Phone number ID and an access token.
   The token shown there expires in 24 hours; for real use create a
   permanent one under Business Settings → System Users, with the
   `whatsapp_business_messaging` permission.
5. Create and get approval for a message template. Delivery/booking
   updates qualify as **Utility**, which is cheaper and approved faster
   than Marketing.

Current Phone number ID: `1212374565293494`

### Supabase side

Add these under
[Project Settings → Edge Functions → Secrets](https://supabase.com/dashboard/project/gaacsvsadghhhsoiraxc/settings/functions):

| Secret | Value |
| --- | --- |
| `WHATSAPP_TOKEN` | the access token from Meta |
| `WHATSAPP_PHONE_NUMBER_ID` | `1212374565293494` |

Put the token in via the dashboard rather than the CLI so it does not end
up in shell history.

Then deploy the send function:

```bash
cd C:\Users\admin\lpg_dealer_accounts
npx supabase login
npx supabase link --project-ref gaacsvsadghhhsoiraxc
npx supabase functions deploy send-whatsapp-broadcast
```

### Sending

Sign in as Owner or Manager → **WhatsApp Broadcast** tab:

1. Import customers from Excel/CSV (columns: consumer_no, name, phone, line)
2. Register the template name exactly as Meta approved it
3. Compose a broadcast — this only *queues* recipients, it sends nothing
4. Click **Send Next Batch** to send up to 250, and click it again on
   later days as Meta raises the limit

Sending is always an explicit click. Nothing sends on a schedule or in
the background.
