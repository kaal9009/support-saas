import { hashPassword, verifyPassword, randomInstallCode, randomTempPassword, randomToken } from "./crypto.js";
import { createSession, sessionCookie, clearSessionCookie, readSessionToken, requireSession, destroySession } from "./session.js";
import { createClientAuthKey } from "./tailscale.js";
import { sendTempPasswordEmail } from "./email.js";

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
const bad = (msg, status = 400) => json({ error: msg }, { status });

const INSTALL_CODE_TTL_MIN = 30; // a generated code is only valid for 30 minutes if unused

// Served inline for /install/<code> — see the route below for why this isn't
// fetched from env.ASSETS. Keep this in sync with public/install/index.html
// (same file, just inlined so the dynamic route can't get redirected).
const INSTALL_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm Remote Support</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div class="wrap">
  <div class="card" id="card">Loading…</div>
</div>
<script>
  const code = location.pathname.split('/').pop();

  async function load() {
    const card = document.getElementById('card');
    let res, data;
    try {
      res = await fetch('/api/install/' + encodeURIComponent(code));
      data = await res.json();
    } catch (e) {
      card.innerHTML = '<p class="err">Could not reach the server. Check your internet connection and reload.</p>';
      return;
    }
    if (!res.ok) {
      card.innerHTML = \`<h1>Can't continue</h1><p class="sub">\${escapeHtml(data.error || 'Something went wrong.')}</p>
        <p class="sub">Ask your technician for a fresh code.</p>\`;
      return;
    }
    render(data);
  }

  function render(data) {
    const card = document.getElementById('card');
    card.innerHTML = \`
      <h1>Allow remote support?</h1>
      <p class="sub"><strong>\${escapeHtml(data.business_name)}</strong> wants to connect to this PC to help you.
      This installs a small support agent that lets them see and control this computer remotely, over an
      encrypted connection, until the session ends. It does <strong>not</strong> change your Windows password
      or create any new account on this PC. You can remove it at any time.</p>
      <button class="primary" id="agree">I agree — set up support</button>
      <button class="secondary" id="decline">Cancel</button>
      <div class="err" id="err"></div>
    \`;
    document.getElementById('decline').onclick = () => { location.href = '/'; };
    document.getElementById('agree').onclick = async () => {
      const btn = document.getElementById('agree');
      btn.disabled = true; btn.textContent = 'Setting up…';
      try {
        const res = await fetch('/api/install/' + encodeURIComponent(code) + '/consent', { method: 'POST' });
        if (!res.ok) {
          const d = await res.json();
          document.getElementById('err').textContent = d.error || 'Something went wrong.';
          btn.disabled = false; btn.textContent = 'I agree — set up support';
          return;
        }
        location.href = '/api/install/' + encodeURIComponent(code) + '/download';
        card.innerHTML = \`<h1>Downloading…</h1><p class="sub">Open the downloaded file and run it. A black window
          will appear for a minute while it connects — you can close it once it says "Connected".</p>\`;
      } catch (e) {
        document.getElementById('err').textContent = 'Could not reach the server.';
        btn.disabled = false; btn.textContent = 'I agree — set up support';
      }
    };
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  load();
</script>
</body>
</html>
`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    try {
      // ---------- Admin auth ----------
      if (path === "/api/admin/login" && request.method === "POST") {
        const { email, password } = await request.json();
        const admin = await db.prepare("SELECT * FROM admins WHERE email = ?").bind(email).first();
        if (!admin || !(await verifyPassword(password, admin.password_hash, admin.password_salt))) {
          return bad("Invalid email or password", 401);
        }
        const { token, expires } = await createSession(db, "admin", admin.id);
        return json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(token, expires) } });
      }

      if (path === "/api/admin/logout" && request.method === "POST") {
        await destroySession(db, readSessionToken(request));
        return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
      }

      // ---------- Admin: buyer management ----------
      if (path === "/api/admin/buyers" && request.method === "GET") {
        const admin = await requireSession(request, db, "admin");
        if (!admin) return bad("Not logged in", 401);
        const { results } = await db
          .prepare("SELECT id, email, business_name, status, must_reset_password, created_at FROM buyers ORDER BY created_at DESC")
          .all();
        return json({ buyers: results });
      }

      if (path === "/api/admin/buyers" && request.method === "POST") {
        const admin = await requireSession(request, db, "admin");
        if (!admin) return bad("Not logged in", 401);
        const { email, business_name } = await request.json();
        if (!email || !business_name) return bad("email and business_name are required");
        const existing = await db.prepare("SELECT id FROM buyers WHERE email = ?").bind(email).first();
        if (existing) return bad("A buyer with this email already exists");

        const tempPassword = randomTempPassword();
        const { hash, salt } = await hashPassword(tempPassword);
        const id = randomToken(12);
        await db
          .prepare(
            "INSERT INTO buyers (id, email, business_name, password_hash, password_salt, must_reset_password) VALUES (?, ?, ?, ?, ?, 1)"
          )
          .bind(id, email, business_name, hash, salt)
          .run();

        // Temp password is returned ONCE, here, to the admin — never stored in plaintext.
        // Best-effort email too (no-op if RESEND_API_KEY isn't set — see worker/email.js):
        // doesn't block or fail the response either way, since the admin panel is the
        // fallback source of truth for the temp password.
        const emailResult = await sendTempPasswordEmail(env, {
          to: email,
          businessName: business_name,
          tempPassword,
          loginUrl: `${url.origin}/buyer/`,
        });
        return json({
          ok: true,
          buyer: { id, email, business_name },
          temp_password: tempPassword,
          email_sent: emailResult.sent,
        });
      }

      if (path.match(/^\/api\/admin\/buyers\/[^/]+$/) && request.method === "DELETE") {
        const admin = await requireSession(request, db, "admin");
        if (!admin) return bad("Not logged in", 401);
        const buyerId = path.split("/")[4];
        const buyer = await db.prepare("SELECT id FROM buyers WHERE id = ?").bind(buyerId).first();
        if (!buyer) return bad("Buyer not found", 404);

        // No DB-enforced cascade — clean up dependents manually, then the buyer itself.
        const { results: clientRows } = await db
          .prepare("SELECT id FROM clients WHERE buyer_id = ?")
          .bind(buyerId)
          .all();
        for (const c of clientRows) {
          await db.prepare("DELETE FROM install_codes WHERE client_id = ?").bind(c.id).run();
          await db.prepare("DELETE FROM support_escalations WHERE client_id = ?").bind(c.id).run();
        }
        await db.prepare("DELETE FROM clients WHERE buyer_id = ?").bind(buyerId).run();
        await db.prepare("DELETE FROM sessions WHERE subject_type = 'buyer' AND subject_id = ?").bind(buyerId).run();
        await db.prepare("DELETE FROM buyers WHERE id = ?").bind(buyerId).run();
        return json({ ok: true });
      }

      // ---------- Admin: view all clients across all buyers ----------
      // RustDesk connect details are only included when the buyer has
      // actually consented (admin_support_allowed=1, set via the buyer's
      // "Ask admin for help" button or escalation) — enforced here in the
      // query itself, not just hidden in the UI, so the master admin can't
      // get a buyer's client's RustDesk password just by asking the API.
      if (path === "/api/admin/clients" && request.method === "GET") {
        const admin = await requireSession(request, db, "admin");
        if (!admin) return bad("Not logged in", 401);
        const { results } = await db
          .prepare(
            `SELECT c.id, c.label, c.status, c.admin_support_allowed, c.last_seen_at,
                    CASE WHEN c.admin_support_allowed = 1 THEN c.rustdesk_id END as rustdesk_id,
                    CASE WHEN c.admin_support_allowed = 1 THEN c.rustdesk_password END as rustdesk_password,
                    CASE WHEN c.admin_support_allowed = 1 THEN c.tailscale_ip END as tailscale_ip,
                    b.id as buyer_id, b.business_name, b.email as buyer_email
             FROM clients c JOIN buyers b ON b.id = c.buyer_id
             ORDER BY c.created_at DESC`
          )
          .all();
        return json({ clients: results });
      }

      // ---------- Admin: open escalations needing attention ----------
      if (path === "/api/admin/escalations" && request.method === "GET") {
        const admin = await requireSession(request, db, "admin");
        if (!admin) return bad("Not logged in", 401);
        const { results } = await db
          .prepare(
            `SELECT e.*, c.label as client_label, b.business_name
             FROM support_escalations e
             JOIN clients c ON c.id = e.client_id
             JOIN buyers b ON b.id = e.buyer_id
             WHERE e.resolved = 0
             ORDER BY e.created_at ASC`
          )
          .all();
        return json({ escalations: results });
      }

      if (path.match(/^\/api\/admin\/escalations\/[^/]+\/resolve$/) && request.method === "POST") {
        const admin = await requireSession(request, db, "admin");
        if (!admin) return bad("Not logged in", 401);
        const id = path.split("/")[4];
        await db.prepare("UPDATE support_escalations SET resolved = 1 WHERE id = ?").bind(id).run();
        return json({ ok: true });
      }

      // ---------- Buyer auth ----------
      if (path === "/api/buyer/login" && request.method === "POST") {
        const { email, password } = await request.json();
        const buyer = await db.prepare("SELECT * FROM buyers WHERE email = ?").bind(email).first();
        if (!buyer || buyer.status !== "active" || !(await verifyPassword(password, buyer.password_hash, buyer.password_salt))) {
          return bad("Invalid email or password", 401);
        }
        const { token, expires } = await createSession(db, "buyer", buyer.id);
        return json(
          { ok: true, must_reset_password: !!buyer.must_reset_password },
          { headers: { "Set-Cookie": sessionCookie(token, expires) } }
        );
      }

      if (path === "/api/buyer/logout" && request.method === "POST") {
        await destroySession(db, readSessionToken(request));
        return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
      }

      if (path === "/api/buyer/reset-password" && request.method === "POST") {
        const session = await requireSession(request, db, "buyer");
        if (!session) return bad("Not logged in", 401);
        const { new_password } = await request.json();
        if (!new_password || new_password.length < 10) return bad("Password must be at least 10 characters");
        const { hash, salt } = await hashPassword(new_password);
        await db
          .prepare("UPDATE buyers SET password_hash = ?, password_salt = ?, must_reset_password = 0 WHERE id = ?")
          .bind(hash, salt, session.subject_id)
          .run();
        return json({ ok: true });
      }

      if (path === "/api/buyer/me" && request.method === "GET") {
        const session = await requireSession(request, db, "buyer");
        if (!session) return bad("Not logged in", 401);
        const buyer = await db
          .prepare("SELECT id, email, business_name, must_reset_password, ssh_public_key FROM buyers WHERE id = ?")
          .bind(session.subject_id)
          .first();
        return json({ buyer });
      }

      // Buyer sets the SSH public key that gets embedded into every one of
      // their clients' install scripts. Required before they can generate a
      // code that actually works (see /api/install/.../download below) —
      // this is deliberately never Rohit's own personal key.
      if (path === "/api/buyer/ssh-key" && request.method === "POST") {
        const session = await requireSession(request, db, "buyer");
        if (!session) return bad("Not logged in", 401);
        const { ssh_public_key } = await request.json();
        const key = (ssh_public_key || "").trim();
        if (!key) return bad("ssh_public_key is required");
        if (!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+)\s+\S+/.test(key)) {
          return bad("That doesn't look like a valid SSH public key (should start with ssh-ed25519, ssh-rsa, etc.)");
        }
        await db.prepare("UPDATE buyers SET ssh_public_key = ? WHERE id = ?").bind(key, session.subject_id).run();
        return json({ ok: true });
      }

      // ---------- Buyer: clients ----------
      if (path === "/api/buyer/clients" && request.method === "GET") {
        const session = await requireSession(request, db, "buyer");
        if (!session) return bad("Not logged in", 401);
        const { results } = await db
          .prepare("SELECT * FROM clients WHERE buyer_id = ? ORDER BY created_at DESC")
          .bind(session.subject_id)
          .all();
        return json({ clients: results });
      }

      if (path === "/api/buyer/clients" && request.method === "POST") {
        const session = await requireSession(request, db, "buyer");
        if (!session) return bad("Not logged in", 401);
        const { label } = await request.json();
        if (!label) return bad("label is required");

        const clientId = randomToken(12);
        await db
          .prepare("INSERT INTO clients (id, buyer_id, label, status) VALUES (?, ?, ?, 'pending')")
          .bind(clientId, session.subject_id, label)
          .run();

        const code = randomInstallCode();
        const expires = new Date(Date.now() + INSTALL_CODE_TTL_MIN * 60 * 1000).toISOString();
        await db
          .prepare("INSERT INTO install_codes (code, buyer_id, client_id, expires_at) VALUES (?, ?, ?, ?)")
          .bind(code, session.subject_id, clientId, expires)
          .run();

        return json({ ok: true, client_id: clientId, code, expires_at: expires });
      }

      // Buyer asks the master admin to step in on one of their clients (explicit, logged consent)
      if (path === "/api/buyer/escalate" && request.method === "POST") {
        const session = await requireSession(request, db, "buyer");
        if (!session) return bad("Not logged in", 401);
        const { client_id, note } = await request.json();
        const client = await db
          .prepare("SELECT * FROM clients WHERE id = ? AND buyer_id = ?")
          .bind(client_id, session.subject_id)
          .first();
        if (!client) return bad("Client not found", 404);

        await db.prepare("UPDATE clients SET admin_support_allowed = 1 WHERE id = ?").bind(client_id).run();
        const id = randomToken(12);
        await db
          .prepare(
            "INSERT INTO support_escalations (id, client_id, buyer_id, requested_by, note) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(id, client_id, session.subject_id, session.subject_id, note || "")
          .run();
        return json({ ok: true });
      }

      // ---------- Public: install code lookup + consent + download ----------
      // No auth here on purpose — this is the page the END CLIENT (not the buyer) opens.
      if (path.match(/^\/api\/install\/[^/]+$/) && request.method === "GET") {
        const code = path.split("/")[3];
        const row = await db
          .prepare(
            `SELECT ic.*, b.business_name FROM install_codes ic
             JOIN buyers b ON b.id = ic.buyer_id
             WHERE ic.code = ?`
          )
          .bind(code)
          .first();
        if (!row) return bad("Invalid code", 404);
        if (row.used_at) return bad("This code has already been used", 410);
        if (new Date(row.expires_at) < new Date()) return bad("This code has expired — ask for a new one", 410);
        return json({ business_name: row.business_name, consented: !!row.consented_at });
      }

      if (path.match(/^\/api\/install\/[^/]+\/consent$/) && request.method === "POST") {
        const code = path.split("/")[3];
        const row = await db.prepare("SELECT * FROM install_codes WHERE code = ?").bind(code).first();
        if (!row) return bad("Invalid code", 404);
        if (row.used_at) return bad("This code has already been used", 410);
        if (new Date(row.expires_at) < new Date()) return bad("This code has expired", 410);
        await db.prepare("UPDATE install_codes SET consented_at = datetime('now') WHERE code = ?").bind(code).run();
        return json({ ok: true });
      }

      if (path.match(/^\/api\/install\/[^/]+\/download$/) && request.method === "GET") {
        const code = path.split("/")[3];
        const row = await db.prepare("SELECT * FROM install_codes WHERE code = ?").bind(code).first();
        if (!row) return bad("Invalid code", 404);
        if (!row.consented_at) return bad("Please accept the consent screen first", 403);
        if (row.used_at) return bad("This code has already been used", 410);
        if (new Date(row.expires_at) < new Date()) return bad("This code has expired", 410);

        const buyer = await db.prepare("SELECT ssh_public_key FROM buyers WHERE id = ?").bind(row.buyer_id).first();
        if (!buyer || !buyer.ssh_public_key) {
          return bad("This technician hasn't finished setup yet (missing SSH key) — ask them to check their dashboard", 409);
        }

        let authkey;
        try {
          authkey = await createClientAuthKey(env, { buyerId: row.buyer_id, clientId: row.client_id });
        } catch (err) {
          // Tailscale secrets not configured yet, or the API call failed — fail
          // loudly instead of handing out a broken installer.
          return bad(`Could not provision a connection key: ${err.message}`, 502);
        }

        await db
          .prepare("UPDATE install_codes SET used_at = datetime('now') WHERE code = ?")
          .bind(code)
          .run();
        await db.prepare("UPDATE clients SET status = 'awaiting_connection' WHERE id = ?").bind(row.client_id).run();

        const script = buildInstallerScript({
          code,
          clientId: row.client_id,
          buyerId: row.buyer_id,
          authkey,
          sshPublicKey: buyer.ssh_public_key,
          origin: url.origin,
        });
        return new Response(script, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": 'attachment; filename="SUPPORT-SETUP.bat"',
          },
        });
      }

      // The installer calls this once it's done, to hand back the details it
      // only knows AFTER running on the client's own machine: the Tailscale
      // IP it got assigned, and the RustDesk ID + unattended password the
      // RustDesk install generated locally (we can't mint these ourselves the
      // way we mint the Tailscale auth key — they only exist once RustDesk
      // has actually installed and run on that PC). No auth — same trust
      // model as the rest of the public install flow: only works for a code
      // that's already been downloaded (used_at set), once (checked by
      // clearing a report_received flag... kept simple: just requires
      // used_at to be set, same guard as everything else here).
      if (path.match(/^\/api\/install\/[^/]+\/report$/) && request.method === "POST") {
        const code = path.split("/")[3];
        const row = await db.prepare("SELECT * FROM install_codes WHERE code = ?").bind(code).first();
        if (!row) return bad("Invalid code", 404);
        if (!row.used_at) return bad("This code hasn't been used yet", 400);

        const { tailscale_ip, rustdesk_id, rustdesk_password } = await request.json();
        await db
          .prepare(
            `UPDATE clients SET
               tailscale_ip = COALESCE(?, tailscale_ip),
               rustdesk_id = COALESCE(?, rustdesk_id),
               rustdesk_password = COALESCE(?, rustdesk_password),
               status = 'online',
               last_seen_at = datetime('now')
             WHERE id = ?`
          )
          .bind(tailscale_ip || null, rustdesk_id || null, rustdesk_password || null, row.client_id)
          .run();
        return json({ ok: true });
      }

      // ---------- Static pages ----------
      // /install/<code> is a client-side page (code read from the URL by JS);
      // always serve the same install page for any code.
      //
      // NOTE: this is served inline (not via env.ASSETS.fetch) on purpose.
      // Cloudflare's static-asset binding canonicalizes "/install/index.html"
      // to "/install/" and returns a redirect response for it; if that
      // redirect is passed straight through, the browser follows it and
      // lands on "/install/" with the code stripped from the URL, which then
      // breaks the page (it reads the code from location.pathname). Found by
      // live testing — a real client got "Could not reach the server" on the
      // install page because of this.
      if (path.match(/^\/install\/[^/]+$/) && request.method === "GET") {
        return new Response(INSTALL_PAGE_HTML, {
          headers: { "content-type": "text/html; charset=UTF-8" },
        });
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      return bad(`Server error: ${err.message}`, 500);
    }
  },
};

// Phase 2 installer: real SSH + Tailscale agent, using a freshly-minted,
// single-use Tailscale auth key (tagged for this buyer) and that buyer's own
// SSH public key — never Rohit's personal key, never a shared/static one.
//
// Deliberately does NOT touch the client's Windows password, does NOT create a
// hidden admin account, and does NOT enable silent auto-login — those stay
// Rohit's own personal-dashboard-only recovery tools and are never shipped in
// anything a reseller hands to a third party. (See PROJECT_STATE.md / memory
// "Hard safety constraint" — do not re-add without asking again.)
function buildInstallerScript({ code, clientId, buyerId, authkey, sshPublicKey, origin }) {
  // The PowerShell body is passed to the client as a single -EncodedCommand
  // (Base64 of UTF-16LE), NOT written out via batch `echo` lines — batch
  // quoting/escaping of a multi-line script full of $, (), |, & is exactly
  // the kind of fragility that broke the personal kit's packaging before
  // (see remote-support-kit memory). -EncodedCommand sidesteps all of that:
  // no escaping, no quoting, nothing for cmd.exe to misinterpret.
  const pubKey = sshPublicKey.trim();
  // RustDesk's unattended-access password — generated here (not read back
  // from the client) so it's hex-only (0-9a-f). Deliberately avoiding
  // randomTempPassword()'s punctuation characters: we already got bitten
  // once by a CLI argument rejecting punctuation (Tailscale's description
  // field and parentheses — see memory), so every value handed to a
  // command-line tool in this installer stays plain alphanumeric on purpose.
  const rdPassword = randomToken(8);
  const ps1 = [
    '$ErrorActionPreference = "Stop"',
    // Older Windows Server PowerShell 5.1 (.NET Framework) doesn't enable
    // TLS 1.2 by default — hitting github.com without this causes exactly
    // "The request was aborted: The connection was closed unexpectedly"
    // (found via a real RDP test run). Force it on before any download.
    '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
    'Write-Host "============================================"',
    'Write-Host "  Setting up your remote support connection"',
    'Write-Host "============================================"',
    'Write-Host "Installing OpenSSH Server..."',
    "if (-not (Get-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Where-Object State -eq Installed)) { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }",
    "Set-Service -Name sshd -StartupType Automatic",
    "Start-Service sshd -ErrorAction SilentlyContinue",
    '$sshdConfig = "$env:ProgramData\\ssh\\sshd_config"',
    "if (Test-Path $sshdConfig) { (Get-Content $sshdConfig) -replace '^#?StrictModes.*', 'StrictModes no' | Set-Content $sshdConfig; Restart-Service sshd -ErrorAction SilentlyContinue }",
    `$pubKey = "${pubKey.replace(/"/g, '`"')}"`,
    '$adminKeys = "$env:ProgramData\\ssh\\administrators_authorized_keys"',
    "Set-Content -Path $adminKeys -Value $pubKey -Encoding ASCII -Force",
    'icacls $adminKeys /inheritance:r | Out-Null',
    'icacls $adminKeys /grant "SYSTEM:F" "Administrators:F" | Out-Null',
    '$userSsh = "$env:USERPROFILE\\.ssh"',
    "New-Item -ItemType Directory -Path $userSsh -Force | Out-Null",
    'Set-Content -Path "$userSsh\\authorized_keys" -Value $pubKey -Encoding ASCII -Force',
    'Write-Host "SSH ready. Installing Tailscale..."',
    '$tsExe = "$env:ProgramFiles\\Tailscale\\tailscale.exe"',
    "if (-not (Test-Path $tsExe)) {",
    "  try { winget install --id Tailscale.Tailscale -e --silent --accept-source-agreements --accept-package-agreements } catch {}",
    "  if (-not (Test-Path $tsExe)) {",
    '    Write-Host "winget unavailable, downloading Tailscale directly..."',
    '    $msi = "$env:TEMP\\tailscale-setup.exe"',
    '    Invoke-WebRequest -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe" -OutFile $msi -UseBasicParsing',
    '    Start-Process -FilePath $msi -ArgumentList "/quiet" -Wait',
    "  }",
    "}",
    "Start-Sleep -Seconds 3",
    `& "$tsExe" up --authkey="${authkey}" --hostname="support-${clientId}" --accept-routes --unattended | Out-Null`,
    "Start-Sleep -Seconds 2",
    "$tsIp = ((& \"$tsExe\" ip -4) | Select-Object -First 1).Trim()",
    'Write-Host "Tailscale connected. Installing RustDesk (remote screen access)..."',
    '$rdExe = "$env:ProgramFiles\\RustDesk\\rustdesk.exe"',
    "if (-not (Test-Path $rdExe)) {",
    '  $rdSetup = "$env:TEMP\\rustdesk-setup.exe"',
    // GitHub's releases/latest/download/<name> shortcut only works if that
    // exact asset name exists — RustDesk's asset names are versioned
    // (rustdesk-1.4.3-x86_64.exe), there is no plain "rustdesk-setup.exe",
    // which is why this 404'd on a real test run. Ask the GitHub API for
    // the latest release's real asset URL instead, so this keeps working
    // across RustDesk version bumps. Falls back to a pinned known-good
    // version's URL if the API call itself fails for any reason.
    '  $rdUrl = "https://github.com/rustdesk/rustdesk/releases/download/1.4.3/rustdesk-1.4.3-x86_64.exe"',
    "  try {",
    '    $rdRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/rustdesk/rustdesk/releases/latest" -UseBasicParsing -Headers @{ "User-Agent" = "support-saas-installer" }',
    "    $rdAsset = $rdRelease.assets | Where-Object { $_.name -match '^rustdesk-[0-9.]+-x86_64\\.exe$' } | Select-Object -First 1",
    "    if ($rdAsset) { $rdUrl = $rdAsset.browser_download_url }",
    "  } catch {",
    '    Write-Host "Could not look up latest RustDesk release, using pinned fallback version."',
    "  }",
    "  $rdDownloaded = $false",
    "  $curlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue)",
    "  for ($i = 1; $i -le 3; $i++) {",
    "    try {",
    "      if ($curlExe) {",
    "        # curl.exe (built into Windows 10 1803+/Server 2019+) uses WinHTTP,",
    "        # which handles TLS/redirects more reliably than Invoke-WebRequest",
    "        # on some locked-down cloud networks (seen failing on an Oracle",
    "        # Cloud VM even with TLS 1.2 forced on).",
    '        & curl.exe -L -sS --fail -o $rdSetup $rdUrl',
    "        if ($LASTEXITCODE -ne 0) { throw \"curl.exe exited $LASTEXITCODE\" }",
    "      } else {",
    "        Invoke-WebRequest -Uri $rdUrl -OutFile $rdSetup -UseBasicParsing -MaximumRedirection 10",
    "      }",
    "      if ((Test-Path $rdSetup) -and (Get-Item $rdSetup).Length -gt 1MB) {",
    "        $rdDownloaded = $true",
    "        break",
    "      } else {",
    '        throw "downloaded file missing or too small"',
    "      }",
    "    } catch {",
    '      Write-Host "RustDesk download attempt $i failed: $($_.Exception.Message)"',
    "      Start-Sleep -Seconds 3",
    "    }",
    "  }",
    "  if ($rdDownloaded) { Start-Process -FilePath $rdSetup -ArgumentList \"--silent-install\" -Wait }",
    '  else { Write-Host "Could not download RustDesk after 3 tries — continuing without it (SSH/Tailscale still work)." }',
    "}",
    "$rdId = $null",
    "if (Test-Path $rdExe) {",
    "  Start-Sleep -Seconds 3",
    `  & "$rdExe" --password ${rdPassword} 2>$null | Out-Null`,
    // A fresh install needs a moment to contact RustDesk's rendezvous
    // server and get assigned a permanent ID — a fixed 2s wait was too
    // short on a real test run (password saved fine, ID came back empty).
    // Poll for up to ~20s instead of a single fixed sleep.
    "  for ($i = 1; $i -le 10; $i++) {",
    "    Start-Sleep -Seconds 2",
    "    $rdId = $null",
    "    try {",
    '      $rdOut = & "$rdExe" --get-id 2>$null',
    "      if ($rdOut) { $rdId = ($rdOut | Select-Object -Last 1).ToString().Trim() }",
    "    } catch {}",
    "    if ($rdId -and $rdId -match '^[0-9]+$') { break }",
    "    $rdId = $null",
    "  }",
    '  if ($rdId) { Write-Host "RustDesk ready (ID: $rdId)." }',
    '  else { Write-Host "RustDesk installed but no ID yet — it may appear a little later; SSH/Tailscale still work now." }',
    "}",
    "try {",
    "  $report = @{ tailscale_ip = $tsIp; rustdesk_id = $rdId; rustdesk_password = \"" + rdPassword + "\" } | ConvertTo-Json -Compress",
    `  Invoke-RestMethod -Uri "${origin}/api/install/${code}/report" -Method POST -Body $report -ContentType "application/json" -UseBasicParsing | Out-Null`,
    "} catch {",
    '  Write-Host "(Could not report connection details back — your technician can still connect via Tailscale/SSH.)"',
    "}",
    'Write-Host ""',
    'Write-Host "All set - your technician can now connect to help you."',
    'Write-Host "This window will close in 10 seconds."',
    "Start-Sleep -Seconds 10",
  ].join("\r\n");

  const encodedCommand = toPowerShellEncodedCommand(ps1);

  return `@echo off
:: Remote support setup - code ${code}. Installs OpenSSH + Tailscale only.
:: Does NOT change your Windows login password or create any new account.
setlocal
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator access...
  powershell -Command "Start-Process '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand}
pause
`;
}

// PowerShell's -EncodedCommand expects Base64 of the script in UTF-16LE.
function toPowerShellEncodedCommand(script) {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
