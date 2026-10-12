// c24 — the mesh object (SPEC §18.10, §18.1; Agent Messaging 0.7). Every
// credential-issuing answer tells the client where the mesh is, so a client
// needs only the mesh home's address. This test takes one credential answer
// (the node-credential door, lib/credential-answer.mjs) and checks its `mesh`
// object on any binding:
//
//   - `name`, a non-empty string;
//   - `protocol`, the wire version, whose major matches the wire version this
//     suite speaks (§20.1, §20.2);
//   - `endpoints`, a non-empty list of well-formed URLs, each scheme naming a
//     binding, and the first address a client of this mesh's binding could
//     use naming that binding.
//
// What only the reference binding sends (`nats_endpoints`) is c24b.
import { bindingOfMesh } from "../../lib/harness.mjs";
import { bindingOfScheme, credentialAnswer, wellFormed } from "../lib/credential-answer.mjs";

// The wire version (§20.1): Agent Messaging 0.7 implementations send 0.3.
const WIRE_MAJOR = "0";

export default {
  id: "c24",
  title: "the mesh object: a credential answer names the mesh, its wire version and its addresses",
  spec: "§18.10, §18.1, §20.1",
  profile: "core",
  async run(env) {
    const answer = await credentialAnswer(env);
    const mesh = answer.mesh;
    if (!mesh || typeof mesh !== "object") return { status: "fail", detail: "the credential answer has no mesh object" };
    const fails = [];
    if (typeof mesh.name !== "string" || !mesh.name.trim()) fails.push(`name is not a non-empty string (${JSON.stringify(mesh.name)})`);
    if (typeof mesh.protocol !== "string" || !/^\d+\.\d+/.test(mesh.protocol)) fails.push(`protocol is not a version (${JSON.stringify(mesh.protocol)})`);
    else if (mesh.protocol.split(".")[0] !== WIRE_MAJOR) fails.push(`protocol ${mesh.protocol} has a major version other than ${WIRE_MAJOR}`);
    const eps = mesh.endpoints;
    if (!Array.isArray(eps) || eps.length === 0) {
      fails.push(`endpoints is not a non-empty list (${JSON.stringify(eps)})`);
    } else {
      const bad = eps.filter((u) => !wellFormed(u));
      if (bad.length) fails.push(`endpoints has addresses that are not URLs: ${JSON.stringify(bad)}`);
      const unknown = eps.filter((u) => wellFormed(u) && !bindingOfScheme(u));
      if (unknown.length) fails.push(`endpoints has schemes that name no binding: ${JSON.stringify(unknown)}`);
      const binding = bindingOfMesh(env.meshWsUrl);
      if (!eps.some((u) => bindingOfScheme(u) === binding)) fails.push(`no address in endpoints names this mesh's binding (${binding}): ${JSON.stringify(eps)}`);
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: `name ${mesh.name}, protocol ${mesh.protocol}, endpoints ${eps.join(" ")}` };
  },
};
