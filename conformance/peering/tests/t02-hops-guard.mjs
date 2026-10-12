// §21 constraint 2 / §5: an envelope whose meta.hops exceeds the bound MUST be
// dropped. Probe: send an echo request (daemon-answered, no model) carrying
// meta.hops far over the bound. A reply means the mesh relayed a loop-worn
// envelope — the guard is not implemented.
//
// A missing reply only means something when the same agent answers a plain
// echo, so the probe goes after a control echo without hops. With the suite's
// own echo agent (lib/echo-agent.mjs) an unanswered control is a failure; with
// someone else's agent it means the target cannot be used to judge the guard,
// which is an env-skip.
import { meshConnect, signedRequest, inboxRequest } from "../lib/mesh.mjs";
import { echoAgent } from "../lib/echo-agent.mjs";

export default {
  id: "t02",
  title: "relay guard: meta.hops over the bound is dropped",
  spec: "SPEC.md §21.2, §5",
  profile: "core",
  async run(env) {
    if (!env.identity?.public_key) throw new Error("env-skip: MESH_IDENTITY_FILE (adapter identity) required");
    const target = await echoAgent(env, "t02", { allow: [env.identity.public_key] });
    const agentId = target.agentId;
    const nc = await meshConnect(env);
    try {
      const control = await inboxRequest(nc, agentId, signedRequest(env, {
        to: agentId,
        skill: "__diag_echo__",
        input: { probe: "hops-guard control" },
      }), 8_000);
      // Any answer will do, an error included (an agent without the echo
      // skill answers OFFERING_NOT_FOUND): it shows the envelope arrived.
      if (control === null) {
        if (target.own) return { status: "fail", detail: "the suite's echo agent did not answer a plain echo, so the mesh did not deliver it" };
        throw new Error(`env-skip: the echo target ${agentId.slice(0, 12)}… did not answer a plain echo, so it cannot show whether the guard drops (set ECHO_TARGET to a live agent, or leave it unset in the core profile)`);
      }
      const envelope = signedRequest(env, {
        to: agentId,
        skill: "__diag_echo__",
        input: { probe: "hops-guard" },
        meta: { hops: 99 },
      });
      const reply = await inboxRequest(nc, agentId, envelope, 8_000);
      if (reply === null) {
        return { status: "pass", detail: "a plain echo was answered; the hops=99 envelope was not delivered (dropped or refused)" };
      }
      return {
        status: "fail",
        detail: "echo replied to an envelope carrying meta.hops=99 — nothing enforces the relay guard yet",
      };
    } finally {
      await nc.close().catch(() => {});
      await target.stop();
    }
  },
};
