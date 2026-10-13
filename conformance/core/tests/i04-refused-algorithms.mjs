// i04 — `alg: none` and HMAC tokens are refused (SPEC §4.14: the algorithm is
// asymmetric; the door refuses `none` and every HMAC algorithm, whatever key
// set the issuer publishes). The HMAC token is keyed with the issuer's public
// key, the classic algorithm-confusion attack.
import { requirePart, withIssuerAndTenant, addTrust, enroll, newAgent, refused, jwt, now } from "../lib/identity.mjs";

export default {
  id: "i04",
  title: "alg none and HMAC tokens are refused",
  spec: "§4.14",
  profile: "identity",
  part: "native enrollment (oauth)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14");
    return withIssuerAndTenant(env, "i04", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const t = now();
      const claims = { iss: issuer.base, aud: env.storefrontBase, sub: "buyer-i04", client_id: "buyer-i04", iat: t, exp: t + 300 };
      const none = jwt({ typ: "at+jwt", alg: "none" }, claims);
      const hmac = jwt({ typ: "at+jwt", alg: "HS256", kid: issuer.kid }, claims, JSON.stringify(issuer.key.jwk));
      const fails = [];
      for (const [name, token] of [["none", none], ["HS256", hmac]]) {
        const r = await enroll(env, { agent_id: newAgent().id, proof: { kind: "oauth", token } });
        if (!refused(r)) fails.push(`an ${name} token enrolled an agent`);
      }
      return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: "both refused" };
    });
  },
};
