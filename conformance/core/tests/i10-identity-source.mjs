// i10 — where an agent's identity came from is attested, filterable and
// served by describe (SPEC §9.7, §9.3, §10.14). An agent enrolled with an
// OAuth token registers a manifest that claims otherwise in its `meta`; the
// registry still reports the attested `identity_source` (kind `oauth`, the
// issuer, the workload identifier), because neither the agent nor its node
// can set it. Discovery filtered by kind `oauth` and the issuer finds the
// agent, filtered by kind `spiffe` does not, and `describe` returns it.
import { requirePart, withIssuerAndTenant, addTrust, enrollNative, connectEnrolled, sourceOf } from "../lib/identity.mjs";

export default {
  id: "i10",
  title: "identity_source appears in discovery and describe, and the node cannot set it",
  spec: "§9.7, §9.3, §10.14",
  profile: "identity",
  part: "provenance (identity_source)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14, §9.7");
    return withIssuerAndTenant(env, "i10", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const { agent, answer } = await enrollNative(env, issuer, "buyer-i10");
      const mesh = await connectEnrolled(env, agent, answer);
      try {
        await mesh.register({
          name: "identity-i10",
          description: "Conformance test agent for identity_source.",
          offerings: [],
          visibility: "unlisted",
          meta: { identity_source: { kind: "mesh" } },
        });
        const fails = [];
        const hit = await mesh.discover({ agent_ids: [agent.id], identity_source: { kind: "oauth", issuer: issuer.base } });
        const found = (hit?.agents ?? []).find((a) => (a.id ?? a.agent_id) === agent.id);
        if (!found) fails.push("discovery filtered by kind oauth and the issuer did not find the agent");
        else if (sourceOf(found)?.kind !== "oauth") fails.push(`discovery reports identity_source ${JSON.stringify(sourceOf(found))}`);
        const miss = await mesh.discover({ agent_ids: [agent.id], identity_source: { kind: "spiffe" } });
        if ((miss?.agents ?? []).some((a) => (a.id ?? a.agent_id) === agent.id)) fails.push("discovery filtered by kind spiffe found the agent");
        const doc = await mesh.describe(agent.id);
        const src = sourceOf(doc);
        if (src?.kind !== "oauth" || src?.workload_id !== "buyer-i10") fails.push(`describe reports identity_source ${JSON.stringify(src)}`);
        return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: "attested oauth source in discovery and describe; the manifest's claim was ignored" };
      } finally {
        await mesh.close().catch(() => {});
      }
    });
  },
};
