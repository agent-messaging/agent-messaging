// §10.14: the pre-admission read, mesh-native: a request with skill
// "describe" answered with {agent_id, card?, public} — fast, because nothing
// thinks. The same document over HTTPS is t05b: SPEC.md §1.6 makes that door
// deployment-defined, so it was split out in step 4 of
// docs/agent-messaging-server-plan.md.
import { meshConnect, signedRequest, inboxRequest } from "../lib/mesh.mjs";
import { echoAgent } from "../lib/echo-agent.mjs";

export default {
  id: "t05",
  title: "describe: pre-admission storefront over the mesh",
  spec: "SPEC.md §10.14, §8.7",
  profile: "core",
  async run(env) {
    if (!env.identity?.public_key) throw new Error("env-skip: MESH_IDENTITY_FILE (adapter identity) required");
    // describe is pre-admission, so the sender is not put on the roster.
    const target = await echoAgent(env, "t05");
    const agentId = target.agentId;
    const problems = [];

    const nc = await meshConnect(env);
    try {
      const t0 = Date.now();
      const reply = await inboxRequest(nc, agentId, signedRequest(env, { to: agentId, skill: "describe" }), 10_000);
      const ms = Date.now() - t0;
      const payload = reply?.payload?.output ?? reply?.payload;
      if (!reply) {
        problems.push("mesh describe: no reply at all");
      } else if (!payload || typeof payload !== "object" || !("public" in payload) || !("agent_id" in payload)) {
        problems.push(`mesh describe: reply is not the §10.14 response shape (got: ${JSON.stringify(payload).slice(0, 120)})`);
      } else if (ms > 3_000) {
        problems.push(`mesh describe: took ${ms}ms — a declared document should answer in well under a second; this smells like a model call`);
      }
    } finally {
      await nc.close().catch(() => {});
      await target.stop();
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : { status: "pass", detail: "describe answers pre-admission over the mesh with the §10.14 shape" };
  },
};
