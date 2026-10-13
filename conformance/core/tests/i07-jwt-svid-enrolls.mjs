// i07 — a JWT-SVID from a trusted SPIFFE trust domain enrolls an agent
// natively (SPEC §4.14), and its identity_source is kind `spiffe` with the
// trust domain, and the SPIFFE ID as its workload identifier (§9.7).
import { requirePart, withIssuerAndTenant, addTrust, enroll, newAgent } from "../lib/identity.mjs";

export default {
  id: "i07",
  title: "a JWT-SVID from a trusted trust domain enrolls an agent natively",
  spec: "§4.14, §9.7",
  profile: "identity",
  part: "native enrollment (jwt-svid)",
  async run(env) {
    await requirePart(env, "enroll:jwt-svid", "§4.14");
    return withIssuerAndTenant(env, "i07", async (issuer, tenant) => {
      const domain = `${tenant}.conformance.example`;
      await addTrust(env, tenant, issuer.spiffeRecord(domain));
      const spiffeId = `spiffe://${domain}/agents/buyer`;
      const r = await enroll(env, { agent_id: newAgent().id, proof: { kind: "jwt-svid", token: issuer.svid(env, spiffeId) } });
      // cut-ok: an error message
      if (r.status !== 200 || !r.json?.jwt) return { status: "fail", detail: `the door did not enroll the agent (${r.status} ${r.text.slice(0, 200)})` };
      const src = r.json.identity_source;
      const fails = [];
      if (src?.kind !== "spiffe") fails.push(`identity_source.kind is ${JSON.stringify(src?.kind)}`);
      if (src?.trust_domain !== domain) fails.push(`identity_source.trust_domain is ${JSON.stringify(src?.trust_domain)}`);
      if (src?.workload_id !== spiffeId) fails.push(`identity_source.workload_id is ${JSON.stringify(src?.workload_id)}`);
      return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: `enrolled as ${spiffeId}` };
    });
  },
};
