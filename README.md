# Support SaaS — Phase 1 (testing on Cloudflare, no domain yet)

Master-admin / buyer (reseller) / client remote-support platform, modeled on how
ScreenConnect's reseller flow works. Runs entirely on Cloudflare's free tier
(Workers + Pages + D1) under a `*.workers.dev` URL until a real domain is bought.

## What this Phase-1 build does

- **Master admin panel** (`/admin`) — create buyer accounts, see every buyer's
  clients, see and resolve support-escalation requests.
- **Buyer panel** (`/buyer`) — log in (forced password reset on first login),
  add a client, get a one-time 30-minute install code to hand to that client,
  ask the master admin to step in on a specific client (explicit, logged
  request — the admin never has silent access).
- **Public client page** (`/`) — client enters the code, sees a plain-language
  consent screen naming the buyer's business, and only then can download the
  installer.

## What it deliberately does NOT do

The installer this generates does **not**:
- touch or remove the client's Windows login password
- create a hidden/extra admin account on the client's PC
- enable silent auto-login

Those three stay exclusively in Rohit's own personal dashboard
(`rsupport/dashboard.ps1`), for his own already-authorized clients only. They
are not part of this resold product — a tool other people buy and silently
install on strangers' machines cannot include password-removal or hidden
accounts without becoming a backdoor. See the project memory file for why.

`buildInstallerScript` in `worker/index.js` now builds a real installer:
OpenSSH Server + a freshly-minted, single-use Tailscale key tagged for that
buyer (using that buyer's own SSH public key, never Rohit's), **plus
RustDesk** for actual GUI remote-desktop access (not just a terminal) — see
"Phase 3" below.

## One-time setup

```
cd support-saas
npm install
wrangler login              # opens a browser, log into your existing Cloudflare account
wrangler d1 create support_saas_db
```

Copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_AFTER_CREATE`), then:

```
npm run db:init:remote
```

Create the first master-admin login:

```
node scripts/seed-admin.mjs you@yourbusiness.com "a-strong-password-here"
```

Copy-paste the `wrangler d1 execute ...` command it prints and run it.

## Deploy

```
npm run deploy
```

This gives you a `https://support-saas.<your-subdomain>.workers.dev` URL.
Open `/admin` and log in with the admin account you just seeded.

## Phase 2 setup — Tailscale provisioning (do this once)

Real per-client Tailscale keys now need a **dedicated Tailscale account for
this product** — never Rohit's personal remote-support-kit tailnet.

1. Go to https://login.tailscale.com/start and create a new account (use
   the same `cop5001@pm.me` identity used for Cloudflare, or any email you
   want this product's tailnet under — just not your personal one).
2. In that tailnet's admin console → **Settings → OAuth clients → Generate
   OAuth client**. Scopes: `Devices Core` (read+write) and `Auth Keys`
   (write). Note the Client ID and Client Secret it shows you (the secret
   is shown once).
3. Same admin console → **Access controls** (the ACL editor) — add a tag
   owner so the OAuth client is allowed to create keys under `tag:buyer`.
   (Tailscale's `tagOwners` keys must be literal tag names — a wildcard like
   `tag:buyer-*` isn't allowed — so every buyer's clients share this one tag;
   which buyer a device belongs to is tracked in our own database, not in the
   tag.) Minimal ACL addition:
   ```
   "tagOwners": {
     "tag:buyer": ["autogroup:admin"]
   }
   ```
   This step is already done for the live `cop3001@pm.me` tailnet.
4. In the Cloudflare dashboard for this Worker (Settings → Variables and
   secrets → Add variable, type **Secret**), add:
   - `TS_OAUTH_CLIENT_ID` → the Client ID from step 2
   - `TS_OAUTH_CLIENT_SECRET` → the Client Secret from step 2
   - `TS_TAILNET` → `-`
5. Have each buyer paste their own SSH public key into their dashboard
   (Buyer Dashboard → "Your SSH key") before they generate any install
   codes — codes won't download an installer until that's set.

Once this is done, every client install mints its own one-time Tailscale
key automatically — nothing else to configure per buyer or per client.

## Email setup — buyer temp passwords (optional, do this once)

By default the admin panel still just shows a new buyer's temp password
once, for you to copy-paste yourself — nothing breaks if you skip this.
To have it emailed to the buyer automatically too:

1. Create a free account at https://resend.com.
2. Settings → API Keys → Create API Key. Copy it (shown once).
3. In the Cloudflare dashboard for this Worker (Settings → Variables and
   secrets → Add variable, type **Secret**), add:
   - `RESEND_API_KEY` → the key from step 2
4. Optional: verify your own sending domain in Resend (Domains → Add
   Domain), then add a second secret `RESEND_FROM` → e.g.
   `Support SaaS <onboarding@yourdomain.com>`. Without this, email sends
   from Resend's own `onboarding@resend.dev`, which only actually delivers
   to the email address your Resend account itself is signed up with — fine
   for testing, not for real buyers.

Once `RESEND_API_KEY` is set, every new buyer account also gets emailed
their login link, email, and temp password automatically.

## Phase 3 — RustDesk (real GUI remote desktop) + the DB migration it needs

The installer now also installs RustDesk (open source, free, no per-seat
licensing — unlike AnyDesk/TeamViewer, which matters once this is being
resold) in unattended mode with its own generated password, and reports its
RustDesk ID + password + Tailscale IP back to us once it's running. The
buyer dashboard shows a "Connect" button per client with those details; the
admin dashboard shows the same, but **only** once the buyer has clicked
"Ask admin for help" on that client (enforced in the API query itself, not
just hidden in the UI).

**One DB migration needs to be run once, manually, before this works** —
same as `migrations/0002_ssh_key.sql` before it (this sandbox can't reach
the Cloudflare API directly to run it itself). In the Cloudflare dashboard →
this D1 database → Console, run:

```sql
ALTER TABLE clients ADD COLUMN rustdesk_id TEXT;
ALTER TABLE clients ADD COLUMN rustdesk_password TEXT;
ALTER TABLE buyers ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
```

(Same as `migrations/0003_rustdesk.sql` in this repo.) Until this is run,
every client install's final "report back" step will silently fail (caught
and ignored — the installer still finishes and Tailscale/SSH still work),
it just won't have RustDesk connect details yet.

Right now RustDesk uses its own public relay servers (no setup needed,
works immediately). Once ready, this should move to a self-hosted relay
(`hbbs`/`hbbr` on a small Linux box — the existing Oracle Cloud account
could host it) for a real resold product, both for reliability and so
client traffic isn't going through a third party's shared relay.

**Not yet built:** Action1 (patching/scripts/RMM) integration, and
"self-heal" (auto-reinstall if RustDesk/Tailscale/SSH gets removed) — the
`buyers.plan` column above exists so self-heal can be gated to a paid
('pro') plan later, same as Rohit's personal kit, where self-heal already
is the single most important feature.

## Still pending after that

1. Buy the real domain, point it at this Worker (`wrangler.toml` → routes).

The full flow (create buyer → buyer sets SSH key → adds client → generates
code → client visits the link, accepts consent, downloads and runs the
installer) has been run end to end on a real Windows Server and confirmed
working — the device shows up tagged `tag:buyer` in the Tailscale admin
console. Along the way this also caught a real bug: Cloudflare's
static-asset binding was intercepting `/install/<code>` and redirecting it
to `/install/` before the Worker ever ran, stripping the code from the URL.
Fixed by serving that page inline from the Worker and adding
`run_worker_first = ["/install/*"]` to `wrangler.toml` — see the commit
history for details if this area needs touching again.
