// i02 — a token whose `aud` does not contain the trust record's audience is
// refused (SPEC §4.14, "The proofs and their checks"). A token minted for
// another resource must not enroll an agent here.
import { requirePart, withIssuerAndTenant, addTrust, enroll, newAgent, refused, reasonOf } from "../lib/identity.mjs";

export default {
  id: "i02",
  title: "a token for another audience is refused",
  spec: "§4.14",
  profile: "identity",
  part: "native enrollment (oauth)",
  async run(env) {
    await requirePart(env, "enroll:oauth", "§4.14");
    return withIssuerAndTenant(env, "i02", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const r = await enroll(env, { agent_id: newAgent().id, proof: { kind: "oauth", token: issuer.token(env, "buyer-i02", { aud: "https://another.example.com" }) } });
      return refused(r)
        ? { status: "pass", detail: `refused (${r.status}, ${reasonOf(r) ?? "no reason given"})` }
        : { status: "fail", detail: "the door enrolled an agent on a token for another audience" };
    });
  },
};
