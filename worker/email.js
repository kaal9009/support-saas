// Email delivery for buyer temp passwords, via Resend (https://resend.com).
//
// Needs one secret on the Worker (Cloudflare dashboard → Settings →
// Variables and secrets, or `wrangler secret put RESEND_API_KEY`):
//   RESEND_API_KEY   from a free Resend account
//
// Optional secret:
//   RESEND_FROM      the "from" address to send as, e.g.
//                     "Support SaaS <onboarding@yourdomain.com>".
//                     If not set, falls back to Resend's own shared test
//                     sender ("onboarding@resend.dev"), which only delivers
//                     to the email address that owns the Resend account —
//                     fine for your own testing, not for real buyers. Once
//                     you verify a domain in Resend, set this to an address
//                     on that domain so it can email any buyer.
//
// If RESEND_API_KEY isn't set, sendTempPasswordEmail() is a no-op that
// returns {sent: false} — the admin panel still shows the temp password
// once, exactly like before this file existed, so nothing breaks while
// Rohit hasn't set up Resend yet.

export async function sendTempPasswordEmail(env, { to, businessName, tempPassword, loginUrl }) {
  if (!env.RESEND_API_KEY) {
    return { sent: false, reason: "RESEND_API_KEY not configured" };
  }

  const from = env.RESEND_FROM || "onboarding@resend.dev";
  const subject = "Your support-saas buyer account";
  const text = [
    `Hi,`,
    ``,
    `An account was created for you on support-saas (${businessName}).`,
    ``,
    `Login page: ${loginUrl}`,
    `Email: ${to}`,
    `Temporary password: ${tempPassword}`,
    ``,
    `You'll be asked to set your own password the first time you sign in.`,
    `This temporary password won't be shown or emailed again, so save it now.`,
  ].join("\n");

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      return { sent: false, reason: `Resend API ${res.status}: ${body}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}
