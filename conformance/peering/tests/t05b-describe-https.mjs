// §10.14: the pre-admission read over HTTPS, the same document t05 reads over
// the mesh, at <home-mesh>/a/<agent-id>, readable by anything that speaks the
// web. SPEC.md §1.6 makes the HTTPS describe door deployment-defined, so this
// half of the old t05 is a platform test (step 4 of
// docs/agent-messaging-for-nats-plan.md).
import { resolveAgentId } from "../lib/env.mjs";

export default {
  id: "t05b",
  title: "describe: pre-admission storefront over HTTPS",
  spec: "SPEC.md §10.14, §8.7",
  // The HTTPS describe door is deployment-defined (SPEC.md §1.6).
  profile: "platform",
  async run(env) {
    if (!env.storefrontBase) throw new Error("env-skip: STOREFRONT_BASE (the mesh's HTTPS API) required");
    if (!env.echoTarget) throw new Error("env-skip: ECHO_TARGET (an agent with a storefront) required");
    const agentId = /^U[A-Z2-7]{55}$/.test(env.echoTarget) ? env.echoTarget : await resolveAgentId(env.registrar, env.echoTarget);
    try {
      const res = await fetch(`${env.storefrontBase}/a/${agentId}`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        return { status: "fail", detail: `HTTPS storefront: GET ${env.storefrontBase}/a/<agent-id> returned ${res.status}` };
      }
      const body = await res.json().catch(() => null);
      if (!body || !("public" in body)) return { status: "fail", detail: "HTTPS storefront: 200 but no public block in the body" };
    } catch (e) {
      return { status: "fail", detail: `HTTPS storefront: ${String(e.message ?? e)}` };
    }
    return { status: "pass", detail: "describe answers pre-admission over HTTPS with a public block" };
  },
};
