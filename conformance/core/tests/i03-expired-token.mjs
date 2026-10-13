// i03 — an expired token is refused (SPEC §4.14: `exp` in the future).
import { requirePart, withIssuerAndTenant, addTrust, enroll, newAgent, refused, reasonOf, now } from "../lib/identity.mjs";

export default {
  id: "i03",
  title: "an expired token is refused",
  spec: "§4.14",
  profile: "identity",
  part: "native enrollment (oauth)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14");
    return withIssuerAndTenant(env, "i03", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const t = now();
      const r = await enroll(env, { agent_id: newAgent().id, proof: { kind: "oauth", token: issuer.token(env, "buyer-i03", { iat: t - 900, exp: t - 600 }) } });
      return refused(r)
        ? { status: "pass", detail: `refused (${r.status}, ${reasonOf(r) ?? "no reason given"})` }
        : { status: "fail", detail: "the door enrolled an agent on a token that expired ten minutes ago" };
    });
  },
};
