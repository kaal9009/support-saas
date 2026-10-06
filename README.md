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
buyer, using that buyer's own SSH public key (never Rohit's). See "Phase 2
setup" below to finish wiring this up.

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
   owner so the OAuth client is allowed to create keys under
   `tag:buyer-*`. Minimal ACL addition:
   ```
   "tagOwners": {
     "tag:buyer-*": ["autogroup:admin"]
   }
   ```
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

## Still pending after that

1. Buy the real domain, point it at this Worker (`wrangler.toml` → routes).
2. Add email delivery for the buyer's temp password (currently shown once
   in the admin panel — you copy-paste it yourself).
3. Walk the full flow yourself end to end (create buyer → buyer sets SSH
   key → adds client → generates code → client installs) — only admin
   login has been tested so far.
