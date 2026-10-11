// c04 — dedup by envelope id (§5.5): the same request envelope delivered
// twice (a sender retry, or live+buffer double-delivery) executes the
// handler exactly once. Claimed by the spec, load-bearing for federation
// double-hearing and for offline drain overlap; never tested before this.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { cleanSlate, seedFor } from "../lib/test-agents.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c04",
  title: "envelope dedup: a retried request executes once",
  spec: "§5.5, §18.8",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;

    const counts = new Map(); // envelope id -> executions
    // A standing, named key (lib/test-agents.mjs), cleared of an earlier run's
    // mailbox first: leftovers drained into this handler would move the counts.
    const seedA = seedFor(env, "c04-target");
    await cleanSlate(env, "c04-target");
    const a = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seedA });
    a.onRequest("echo", async (input, ctx) => {
      const id = ctx?.envelope?.id ?? "?";
      counts.set(id, (counts.get(id) ?? 0) + 1);
      return { ok: input };
    });
    await a.register({ name: "c04-target", visibility: "unlisted", skills: [{ id: "echo", name: "echo", description: "c04" }] });
    const idA = a.agentId;

    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const fails = [];
    const kpS = nkeys.createUser();
    const idS = kpS.getPublicKey();
    // The 0.3 reply path (§6.5): responds arrive at the SENDER's own inbox,
    // correlated by in_reply_to, never on a transport reply subject. Watch the
    // sender's inbox and await the first correlated reply that is not the
    // §6.4a accept, which travels the same inbox and carries no output.
    const replies = [];
    const subS = nc.subscribe(`mesh.agent.${idS}.inbox`);
    (async () => { for await (const m of subS) { try { replies.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ } } })();
    const answerTo = async (id, ms) => {
      for (let i = 0; i * 250 < ms; i++) {
        const r = replies.find((x) => x?.in_reply_to === id && x?.payload?.status !== "accepted");
        if (r) return r;
        await sleep(250);
      }
      return null;
    };
    try {
      const envR = signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { n: 1 } },
        // Per run: the target's key is the same every night, so a fixed key
        // would make tonight's first delivery a repeat of last night's.
        meta: { idempotency_key: `c04-once-${Date.now()}` },
      }), kpS);
      const bytes = te.encode(JSON.stringify(envR));

      // First delivery: must answer, at the sender's inbox.
      nc.publish(`mesh.agent.${idA}.inbox`, bytes);
      const first = await answerTo(envR.id, 8000);
      if (!first) fails.push("first delivery was never answered at the sender's inbox");
      else if (first.error) fails.push(`first delivery errored: ${first.error.message}`);

      // Retries: the SAME bytes, three more times (a nervous sender).
      for (let i = 0; i < 3; i++) { nc.publish(`mesh.agent.${idA}.inbox`, bytes); }
      await nc.flush();
      await sleep(1500);

      const ran = counts.get(envR.id) ?? 0;
      if (ran !== 1) fails.push(`handler executed ${ran} times for one envelope id, want exactly 1`);

      // A DIFFERENT envelope with the same content still executes (dedup is
      // by id, not by content — §5.5).
      const envR2 = signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { n: 1 } },
      }), kpS);
      nc.publish(`mesh.agent.${idA}.inbox`, te.encode(JSON.stringify(envR2)));
      const second = await answerTo(envR2.id, 8000);
      if (!second) fails.push("fresh envelope was never answered at the sender's inbox");
      else if (second.error) fails.push(`fresh envelope errored: ${second.error.message}`);
      if ((counts.get(envR2.id) ?? 0) !== 1) fails.push("fresh envelope with same content did not execute");
      subS.unsubscribe();
    } finally {
      await a.deregister().catch(() => {});
      await a.close().catch(() => {});
      await nc.close().catch(() => {});
      await cleanSlate(env, "c04-target");
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "one envelope retried 4x executed once; a fresh envelope with identical content executed normally" };
  },
};
