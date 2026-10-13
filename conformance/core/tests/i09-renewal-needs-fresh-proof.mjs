// i09 — a credential issued on an outside proof renews only on a fresh proof
// (SPEC §4.14, "Renewal needs a fresh proof"; §4.8). The ordinary renewal,
// for which possession of the node and agent keys is enough, is refused on
// this path; a fresh token for the same workload renews.
import { requirePart, withIssuerAndTenant, addTrust, enroll, newAgent, refused, reasonOf, ordinaryRenewal } from "../lib/identity.mjs";

export default {
  id: "i09",
  title: "renewal without a fresh proof is refused",
  spec: "§4.14, §4.8",
  profile: "identity",
  part: "native enrollment (oauth)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14");
    return withIssuerAndTenant(env, "i09", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const agent = newAgent();
      const first = await enroll(env, { agent_id: agent.id, proof: { kind: "oauth", token: issuer.token(env, "buyer-i09") } });
      // cut-ok: an error message
      if (refused(first) || !first.json.seed) return { status: "fail", detail: `the first enrollment failed (${first.status} ${first.text.slice(0, 160)})` };
      const fails = [];
      const plain = await ordinaryRenewal(env, first.json.seed, agent.kp);
      if (!refused(plain)) fails.push("the ordinary renewal (keys only) issued a credential");
      const fresh = await enroll(env, { agent_id: agent.id, proof: { kind: "oauth", token: issuer.token(env, "buyer-i09") } });
      if (refused(fresh)) fails.push(`a fresh proof for the same workload was refused (${fresh.status}, ${reasonOf(fresh) ?? "no reason given"})`);
      return fails.length
        ? { status: "fail", detail: fails.join("; ") }
        : { status: "pass", detail: `keys-only renewal refused (${reasonOf(plain) ?? plain.status}); a fresh proof renewed` };
    });
  },
};
