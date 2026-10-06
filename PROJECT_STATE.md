# support-saas — Project State (as of 2026-10-06, ~4:15 AM IST)

Read this file FIRST in any new chat about this project, before touching code.

## What this is

A ScreenConnect-style, multi-tenant remote-support SaaS Rohit is building to
SELL to other IT technicians/resellers. Separate from (but currently living
inside the same GitHub repo as) his personal `rsupport` remote-support tool
for his own clients (SSH + Tailscale + AnyDesk, in `CONECTTTTTT/` on this PC).

**Rohit wants this project SEPARATED from `rsupport` — it currently is NOT.**
See "Pending / not yet done" below — this is the top pending item.

## Live right now

- **Live URL:** https://support-saas.cop5001.workers.dev
- **Admin login:** email `cop5001@pm.me`, password `Rsk9!mTq2xVbPwL7`
  (NOT yet confirmed with Rohit that this is the email he actually wants —
  it was inferred from the Cloudflare account's display name. Confirm or
  change it if asked.)
- Deployed via Cloudflare Workers "Connect to Git" (NOT `wrangler deploy` —
  the sandbox this was built in cannot reach Cloudflare's API directly, only
  the dashboard via browser automation worked).
- D1 database `support_saas_db`, id `6576fb82-9484-46e9-afed-0ce7bcff4dab`,
  schema + 1 seeded admin account, both live and working (verified by
  logging in through the actual deployed site).

## Cloudflare account

- Brand NEW, separate Cloudflare account created specifically for this
  project — NOT the old account. Account email `cop5001@pm.me`, account ID
  `891f7afd986e7cdcf8b2db89d6e77d8d`, workers.dev subdomain `cop5001`.
- **CRITICAL — do not ever touch:** Rohit's OLD/original Cloudflare account
  (tied to `cloudpulse@pm.me`) hosts his important SEO domain/DNS. Never
  create, modify, or touch anything there for this or any other new project.
  This was an explicit, repeated instruction from him.

## GitHub

- Currently lives as a **subfolder** `support-saas/` inside the
  `kaal9009/rsupport` repo (not its own repo yet — see Pending below).
- Cloudflare's GitHub App (for this new account) was authorized with access
  scoped to ONLY two repos: `kaal9009/rsupport` and
  `localrepairline-automation`. Rohit explicitly said his `kaal9009` GitHub
  account also has his SEO work on it elsewhere — **never touch any repo
  other than `rsupport` (and, only if he asks, `localrepairline-automation`)
  on that account.**

## Product spec (Rohit's own words, Hinglish, paraphrased)

Master Admin panel → creates Buyer sub-accounts (fixed domain + first-login
password reset) → buyer's dashboard lets them add clients, each getting a
unique per-install code (domain fixed, code changes per install) → buyer's
client visits the fixed domain, enters the code, downloads a customized
installer, connects to buyer's dashboard → Master Admin can see every
buyer's clients across the whole platform, and can personally step in and
support any buyer's client, but ONLY with that buyer's explicit, logged
consent (buyer gives an "allow admin support" toggle / asks admin directly).

## Hard safety constraint — explicitly agreed with Rohit, never reverse without asking him again

Three features that exist in Rohit's OWN personal `dashboard.ps1` (for his
own already-authorized clients) must **NEVER** be added to this resold,
mass-distributed product:
1. Removing/blanking a client's Windows login password
2. Creating a hidden/extra admin account on a client's PC
3. Enabling silent auto-login

Reasoning (Rohit agreed after I raised it): a tool sold to unknown buyers,
silently installed on unknown clients' machines, cannot include these
without being a functional backdoor/RAT. Rohit's exact words: "thk ye 3
featurs hmnahi launch krenge" (okay, we won't launch these 3 features).
This is a durable product-scope decision, not a draft — don't silently
re-add these even "to match ScreenConnect" without raising it with him
again first.

## What's built (Phase 1)

- Cloudflare Workers + D1, free tier, no custom domain yet (`*.workers.dev`
  only — Rohit said buy a real domain only once ready to launch).
- Full schema: admins, buyers, clients, install_codes, sessions,
  support_escalations.
- PBKDF2 password hashing (Web Crypto, matches between Worker and the local
  `scripts/seed-admin.mjs` seeding script).
- Admin panel, buyer panel (forced password reset on first login), public
  install-code + consent flow — all built and visually verified live.
- **The installer itself is currently a PLACEHOLDER** (`buildInstallerScript`
  in `worker/index.js`) — it explains what Phase 2 replaces it with. It does
  NOT yet actually install a working SSH/Tailscale remote-support agent.

## Pending / not yet done

1. **Separate this project from `rsupport`** — Rohit asked for this
   explicitly tonight (2026-10-06). It's currently a subfolder of
   `kaal9009/rsupport`. To actually separate it: create a new standalone
   GitHub repo (the sandbox's `gh` CLI is bound to only the pre-configured
   `kaal9009/rsupport` repo and CANNOT create new repos — this needs either
   Rohit creating the new repo himself, or doing it via GitHub's web UI
   through browser automation), push `support-saas/` there as its own repo
   root, then reconfigure the Cloudflare Workers project's "Connect to Git"
   source to point at the new repo instead. Not done yet — flagged as the
   top priority for the next session on this project.
2. Confirm `cop5001@pm.me` is really the email Rohit wants for the admin
   login (see "Live right now" above).
3. Confirm Rohit revoked the stray Cloudflare API token he had created in
   the OLD (SEO) account during an earlier abandoned approach.
4. Phase 2 (after Phase 1 is tested and Rohit is happy): real per-buyer
   Tailscale provisioning in `buildInstallerScript()` so the installer
   actually works (same safe pattern as his personal `QUICK-INSTALL.bat`:
   random password per install, no shared secrets, properly isolated per
   buyer); email delivery for buyer temp passwords (currently shown once in
   the admin UI, copy-pasted manually); buy a real domain once ready to
   launch and point it at the Worker.
5. Rohit hasn't yet walked through the full flow himself (create buyer →
   buyer resets password → buyer adds client → generates code → public
   consent/download) — I tested admin login only. Ask him how it went.

## Files in this folder

This is a full local copy of the `support-saas/` project as of this save
(mirrors what's pushed to GitHub at `kaal9009/rsupport/support-saas/`).
`worker/index.js` is the main backend; `public/` is the frontend; `migrations/`
has the DB schema; `scripts/seed-admin.mjs` creates admin logins.
