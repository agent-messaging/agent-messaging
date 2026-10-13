// i05 — a trust record that requires binding refuses a token that is not bound
// to a key, and one that is bound but arrives without its DPoP proof (SPEC
// §4.14, "Binding checks"). A bound token with a correct proof enrolls, so the
// refusals are about binding and not about the issuer.
import { requirePart, withIssuerAndTenant, addTrust, enroll, enrollUrl, newAgent, refused, reasonOf, ecKey, dpopProof } from "../lib/identity.mjs";

export default {
  id: "i05",
  title: "a required DPoP proof that is missing is refused",
  spec: "§4.14",
  profile: "identity",
  part: "native enrollment (oauth, DPoP)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14");
    return withIssuerAndTenant(env, "i05", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env, { require_binding: true }));
      const fails = [];
      const unbound = await enroll(env, { agent_id: newAgent().id, proof: { kind: "oauth", token: issuer.token(env, "buyer-i05a") } });
      if (!refused(unbound)) fails.push("an unbound token enrolled under require_binding");
      const k = ecKey();
      const bound = issuer.token(env, "buyer-i05b", { cnf: { jkt: k.thumb } });
      const noProof = await enroll(env, { agent_id: newAgent().id, proof: { kind: "oauth", token: bound } });
      if (!refused(noProof)) fails.push("a bound token enrolled with no DPoP proof");
      const ok = await enroll(env, { agent_id: newAgent().id, proof: { kind: "oauth", token: bound } }, { DPoP: dpopProof(k, { htu: enrollUrl(env), accessToken: bound }) });
      // cut-ok: an error message
      if (refused(ok)) fails.push(`a bound token with a correct DPoP proof was refused (${ok.status}, ${reasonOf(ok) ?? ok.text.slice(0, 120)})`);
      return fails.length
        ? { status: "fail", detail: fails.join("; ") }
        : { status: "pass", detail: `refused unbound (${reasonOf(unbound) ?? unbound.status}) and proofless (${reasonOf(noProof) ?? noProof.status}); enrolled with DPoP` };
    });
  },
};
