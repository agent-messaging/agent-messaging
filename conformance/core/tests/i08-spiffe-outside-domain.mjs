// i08 — a JWT-SVID whose SPIFFE ID is outside the trusted trust domain is
// refused, even though the bundle's key signed it (SPEC §4.14: `sub` is a
// SPIFFE ID in the record's trust domain).
import { requirePart, withIssuerAndTenant, addTrust, enroll, newAgent, refused, reasonOf } from "../lib/identity.mjs";

export default {
  id: "i08",
  title: "a SPIFFE ID outside the trust domain is refused",
  spec: "§4.14",
  profile: "identity",
  part: "native enrollment (jwt-svid)",
  async run(env) {
    await requirePart(env, "enroll:jwt-svid", "§4.14");
    return withIssuerAndTenant(env, "i08", async (issuer, tenant) => {
      const domain = `${tenant}.conformance.example`;
      await addTrust(env, tenant, issuer.spiffeRecord(domain));
      const r = await enroll(env, { agent_id: newAgent().id, proof: { kind: "jwt-svid", token: issuer.svid(env, "spiffe://elsewhere.example/agents/buyer") } });
      return refused(r)
        ? { status: "pass", detail: `refused (${r.status}, ${reasonOf(r) ?? "no reason given"})` }
        : { status: "fail", detail: "the door enrolled an agent whose SPIFFE ID is outside the trusted trust domain" };
    });
  },
};
