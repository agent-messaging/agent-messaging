// c09 — the 1 MB message cap (§18.9): an oversized request fails fast with a
// defined error, not a hang; a payload under the cap crosses fine. The
// failure mode had never been observed before this test.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { cleanSlate, seedFor } from "../lib/test-agents.mjs";

const te = new TextEncoder();
const td = new TextDecoder();

export default {
  id: "c09",
  title: "1 MB cap: oversized fails fast and defined, under-cap crosses",
  spec: "§18.9",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;

    // `maxInboundChars: 0` disables the SDK's own 64 KiB application-layer cap
    // for this target. That cap and the bound this test measures are different
    // things: §18.9 is the TRANSPORT limit (1 MiB per envelope, enforced by the
    // broker), while the SDK cap bounds how much sender text reaches a model.
    // c09's own title says "1 MB cap", so leaving the app cap on would make it
    // assert the wrong layer — its 500 KB "under the cap" case would be refused
    // by the SDK before the broker ever had an opinion.
    // A standing, named key (lib/test-agents.mjs), cleared of an earlier run's
    // mailbox first. The sender below only sends and stays fresh.
    const seedA = seedFor(env, "c09-target");
    await cleanSlate(env, "c09-target");
    const a = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seedA, maxInboundChars: 0 });
    a.onRequest("echo", async (input) => ({ bytes: JSON.stringify(input).length }));
    await a.register({ name: "c09-target", visibility: "unlisted", skills: [{ id: "echo", name: "echo", description: "c09" }] });
    const idA = a.agentId;

    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const fails = [];
    try {
      const kpS = nkeys.createUser();
      const idS = kpS.getPublicKey();
      const mkEnv = (n) => signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { blob: "x".repeat(n) } },
      }), kpS);
      const mk = (env2) => te.encode(JSON.stringify(env2));

      // Under the cap: 500 KB crosses and answers. The answer arrives at the
      // SENDER's inbox correlated by in_reply_to (§6.4), so collect there; the
      // reply subject carries delivery signals only under 0.3.
      const underEnv = mkEnv(500_000);
      const subS = nc.subscribe(`mesh.agent.${idS}.inbox`);
      let ok = null;
      const wait = (async () => {
        for await (const m of subS) {
          let r; try { r = JSON.parse(td.decode(m.data)); } catch { continue; }
          if (r?.in_reply_to !== underEnv.id) continue;
          if (r?.payload?.status === "accepted" && !r.error) continue;
          return r;
        }
        return null;
      })();
      nc.publish(`mesh.agent.${idA}.inbox`, mk(underEnv));
      const timer = setTimeout(() => subS.unsubscribe(), 15_000);
      ok = await wait;
      clearTimeout(timer);
      subS.unsubscribe();
      if (!ok) fails.push("500KB request got no correlated answer at the sender's inbox within 15s");
      else if (ok.error) fails.push(`500KB request errored: ${ok.error.message}`);

      // Over the cap: ~1.2 MB must fail FAST with a defined error, not hang.
      const t0 = Date.now();
      let outcome = "answered";
      try {
        await nc.request(`mesh.agent.${idA}.inbox`, mk(mkEnv(1_200_000)), { timeout: 10_000 });
      } catch (e) {
        outcome = String(e?.code ?? e?.message ?? e);
      }
      const ms = Date.now() - t0;
      if (outcome === "answered") fails.push("a 1.2MB request was DELIVERED — the cap is not enforced");
      else if (/TIMEOUT/i.test(outcome)) fails.push(`oversized send HANGS to timeout (${ms}ms) instead of failing fast`);
      else if (ms > 3000) fails.push(`oversized send took ${ms}ms to fail (${outcome}) — not fast`);
      // else: fast, defined refusal (MAX_PAYLOAD_EXCEEDED or similar) — correct.
    } finally {
      await a.deregister().catch(() => {});
      await a.close().catch(() => {});
      await nc.close().catch(() => {});
      await cleanSlate(env, "c09-target");
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "500KB crossed; 1.2MB refused fast with a defined client-side error" };
  },
};
