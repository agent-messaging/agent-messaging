// i01 — native enrollment by an OAuth token (SPEC §4.14; identity profile,
// part: native enrollment, proof `oauth`). An agent of a tenant that trusts an
// issuer presents a token from it in place of the one-time key, makes its own
// key, and gets the credential the key would have got: the mesh object
// (§18.10), an `identity_source` of kind `oauth` naming the issuer and the
// workload identifier (§9.7), and an owner (§4.13 rule 2: the admin API puts
// the agent in the tenant whose trust record admitted it).
import { requirePart, withIssuerAndTenant, addTrust, enroll, newAgent, adminAgent } from "../lib/identity.mjs";

export default {
  id: "i01",
  title: "an OAuth token from a trusted issuer enrolls an agent natively",
  spec: "§4.14, §9.7, §4.13",
  profile: "identity",
  part: "native enrollment (oauth)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14");
    return withIssuerAndTenant(env, "i01", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const agent = newAgent();
      const r = await enroll(env, { agent_id: agent.id, proof: { kind: "oauth", token: issuer.token(env, "buyer-i01") } });
      if (r.status !== 200 || !r.json?.jwt) return { status: "fail", detail: `the door did not enroll the agent (${r.status} ${r.text.slice(0, 200)})` }; // cut-ok: an error message
      const fails = [];
      if (!Array.isArray(r.json.mesh?.endpoints) || !r.json.mesh.endpoints.length) fails.push("the answer has no mesh object with endpoints (§18.10)");
      const src = r.json.identity_source;
      if (src?.kind !== "oauth") fails.push(`identity_source.kind is ${JSON.stringify(src?.kind)}, not "oauth"`);
      if (src?.issuer !== issuer.base) fails.push(`identity_source.issuer is ${JSON.stringify(src?.issuer)}`);
      if (src?.workload_id !== "buyer-i01") fails.push(`identity_source.workload_id is ${JSON.stringify(src?.workload_id)}`);
      const a = await adminAgent(env, agent.id);
      if (a?.owner?.account !== tenant) fails.push(`the agent belongs to ${JSON.stringify(a?.owner?.account)}, not the tenant whose record admitted it (${tenant})`);
      return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: `enrolled ${agent.id.slice(0, 8)}… into ${tenant} as oauth:${issuer.base} buyer-i01` }; // cut-ok: a key prefix for the board
    });
  },
};
