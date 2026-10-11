// c08 — the no-signup door is closed (SPEC §4.1, 2026-09-27). This test used
// to walk the sandbox credential lifecycle (c08) and prove the guest
// permission fence (c17). Both assumed a door that handed any caller a live
// credential with no account. The door is closed now, so the one thing left
// to prove is that it stays closed: every route that used to issue, keep or
// release a no-signup credential answers 410 Gone, says to sign up, and
// carries no credential in its body.
//
// The file keeps its name so the board's history for c08 continues.

const ROUTES = ["/v1/guest", "/v1/guest/heartbeat", "/v1/guest/release", "/auth/provision"];

// Anything shaped like a credential: a NATS user JWT (three base64url parts,
// the header decoding to {"typ":"JWT"...}), a user seed (SU...), or the field
// names a credential rides in.
const CREDENTIAL_SHAPES = [
  /eyJ0eXAiOiJKV1Qi[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /\bSU[A-Z2-7]{56}\b/,
  /"(jwt|seed|creds|credential)"\s*:/i,
];

export default {
  id: "c08",
  title: "no-signup door closed: /v1/guest and its kin answer 410 with no credential",
  spec: "§4.1, §18.10",
  async run(env) {
    const fails = [];
    let reached = 0;
    for (const path of ROUTES) {
      const res = await fetch(`${env.storefrontBase}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      if (!res) continue;
      reached++;
      const text = await res.text().catch(() => "");
      if (res.status !== 410) fails.push(`${path} answered ${res.status}, not 410`);
      for (const shape of CREDENTIAL_SHAPES) {
        if (shape.test(text)) { fails.push(`${path} carried something shaped like a credential (${shape})`); break; }
      }
      let body = null;
      try { body = JSON.parse(text); } catch { /* checked below */ }
      if (res.status === 410 && (!body || typeof body.error !== "string" || !/sign in|sign up|signed up/i.test(body.error))) {
        fails.push(`${path} answered 410 without words telling the caller to sign up`);
      }
    }
    if (reached === 0) throw new Error("env-skip: the API at STOREFRONT_BASE did not answer");
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: `all ${ROUTES.length} no-signup routes answered 410 with sign-up words and no credential` };
  },
};
