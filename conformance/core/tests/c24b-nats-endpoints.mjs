// c24b — the reference binding's nats_endpoints (SPEC §18.10, "On the
// reference binding"; Agent Messaging 0.7). A mesh on the NATS binding MUST
// still send `nats_endpoints` beside `endpoints`, so clients written before
// 0.7 keep working, and it lists the same addresses. This test takes one
// credential answer (lib/credential-answer.mjs) and checks that the list is
// there, holds only NATS addresses, and matches `endpoints`. c24 checks the
// rest of the object on every binding.
import { bindingOfScheme, credentialAnswer, wellFormed } from "../lib/credential-answer.mjs";

export default {
  id: "c24b",
  title: "the mesh object on NATS: nats_endpoints, the same addresses as endpoints, for clients older than 0.7",
  spec: "§18.10",
  profile: "core",
  binding: "nats",
  async run(env) {
    const answer = await credentialAnswer(env);
    const mesh = answer.mesh ?? {};
    const nats = mesh.nats_endpoints;
    const fails = [];
    if (!Array.isArray(nats) || nats.length === 0) {
      fails.push(`nats_endpoints is not a non-empty list (${JSON.stringify(nats)})`);
    } else {
      const bad = nats.filter((u) => !wellFormed(u) || bindingOfScheme(u) !== "nats");
      if (bad.length) fails.push(`nats_endpoints has addresses that are not NATS URLs: ${JSON.stringify(bad)}`);
      const eps = Array.isArray(mesh.endpoints) ? mesh.endpoints.filter((u) => bindingOfScheme(u) === "nats") : [];
      const same = eps.length === nats.length && eps.every((u) => nats.includes(u));
      if (!same) fails.push(`nats_endpoints ${JSON.stringify(nats)} is not the NATS addresses of endpoints ${JSON.stringify(mesh.endpoints)}`);
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: `nats_endpoints ${nats.join(" ")}` };
  },
};
