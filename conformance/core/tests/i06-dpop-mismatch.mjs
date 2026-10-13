// i06 — a DPoP proof made with a key other than the one the token is bound to
// is refused (SPEC §4.14: the proof's `jwk` thumbprint equals `cnf.jkt`). So
// is a proof whose `ath` names another token, and a proof replayed with the
// same `jti`.
import { requirePart, withIssuerAndTenant, addTrust, enroll, enrollUrl, newAgent, refused, ecKey, dpopProof } from "../lib/identity.mjs";

export default {
  id: "i06",
  title: "a DPoP proof that does not match the token's key is refused",
  spec: "§4.14",
  profile: "identity",
  part: "native enrollment (oauth, DPoP)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14");
    return withIssuerAndTenant(env, "i06", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env, { require_binding: true }));
      const bound = ecKey();
      const other = ecKey();
      const token = issuer.token(env, "buyer-i06", { cnf: { jkt: bound.thumb } });
      const body = () => ({ agent_id: newAgent().id, proof: { kind: "oauth", token } });
      const fails = [];
      const wrongKey = await enroll(env, body(), { DPoP: dpopProof(other, { htu: enrollUrl(env), accessToken: token }) });
      if (!refused(wrongKey)) fails.push("a proof made with another key was accepted");
      const wrongAth = await enroll(env, body(), { DPoP: dpopProof(bound, { htu: enrollUrl(env), accessToken: `${token}x` }) });
      if (!refused(wrongAth)) fails.push("a proof whose ath names another token was accepted");
      const proof = dpopProof(bound, { htu: enrollUrl(env), accessToken: token });
      const first = await enroll(env, body(), { DPoP: proof });
      const replay = await enroll(env, body(), { DPoP: proof });
      if (refused(first)) fails.push(`a correct proof was refused (${first.status})`);
      if (!refused(replay)) fails.push("the same proof (same jti) was accepted twice");
      return fails.length
        ? { status: "fail", detail: fails.join("; ") }
        : { status: "pass", detail: "wrong key, wrong ath and a replayed jti refused; a correct proof accepted" };
    });
  },
};
