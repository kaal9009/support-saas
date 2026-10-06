// Phase 2: real per-client Tailscale provisioning via the Tailscale API.
//
// Needs three secrets set on the Worker (Cloudflare dashboard → Settings →
// Variables and secrets, or `wrangler secret put <NAME>` from a machine with
// wrangler — never pasted into chat or typed by Claude into any web form):
//   TS_OAUTH_CLIENT_ID      OAuth client id from the dedicated SaaS tailnet
//   TS_OAUTH_CLIENT_SECRET  OAuth client secret (same OAuth client)
//   TS_TAILNET              usually "-" (the OAuth client's own tailnet)
//
// This tailnet must be a NEW, separate Tailscale account made just for this
// resold product — never Rohit's personal kit's tailnet. See README.md
// "Phase 2 setup" for the exact console steps.

let cachedToken = null; // { token, expiresAt } — reused across requests in the same isolate

async function getAccessToken(env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }
  const res = await fetch("https://api.tailscale.com/api/v2/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TS_OAUTH_CLIENT_ID,
      client_secret: env.TS_OAUTH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Tailscale OAuth token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// Mints a single-use (reusable: false), non-ephemeral auth key tagged for this
// buyer, so the device shows up pre-authorized and taggable in the tailnet
// admin console (each buyer's clients are findable by their tag:buyer-<id>).
// expirySeconds is short (default 1 hour) — the key is only meant to be used
// once, immediately, by the installer that was just downloaded.
export async function createClientAuthKey(env, { buyerId, clientId, expirySeconds = 3600 }) {
  const tailnet = env.TS_TAILNET || "-";
  const tag = buyerTag(buyerId);
  const token = await getAccessToken(env);

  const res = await fetch(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: false,
            preauthorized: true,
            tags: [tag],
          },
        },
      },
      expirySeconds,
      description: `support-saas client ${clientId} (buyer ${buyerId})`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Tailscale key creation failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.key; // the tskey-auth-... string to hand to `tailscale up`
}

export function buyerTag(buyerId) {
  // Tailscale tags must be lowercase alnum/dash; buyer ids are already that (randomToken hex).
  return `tag:buyer-${buyerId}`;
}
