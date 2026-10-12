// c23 — the presence lookup (§9.6, §10.10): `mesh.presence.get` answers a
// node's current liveness from signed heartbeats, and only from them. Added in
// step 4 of docs/agent-messaging-for-nats-plan.md: the registry has answered
// the subject since step 3 (services/src/registry/handlers/admin.ts), and
// presence is in the core profile (SPEC.md §1.6).
//
//   1. A node nobody has heard from reads offline, with no last_seen.
//   2. A heartbeat signed by the node's own key makes it read online, with a
//      last_seen at or after the heartbeat.
//   3. A heartbeat for another node, signed by a key that node never vouched
//      for, changes nothing: that node still reads offline.
//
// The nodes are fresh keys made for the run. A heartbeat needs no
// registration, so nothing is left behind but two presence entries that go
// stale in a minute.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c23",
  title: "presence lookup: mesh.presence.get answers from signed heartbeats only",
  spec: "§9.6, §10.10",
  profile: "core",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const nc = await connect({
      servers: env.meshWsUrl,
      authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
      timeout: 15_000,
      maxReconnectAttempts: 0,
    });
    const asker = nkeys.createUser();
    const lookup = async (node) => {
      const req = signEnvelope(createEnvelope({ type: "request", from: asker.getPublicKey(), payload: { node } }), asker);
      const msg = await nc.request("mesh.presence.get", te.encode(JSON.stringify(req)), { timeout: 10_000 });
      const reply = JSON.parse(td.decode(msg.data));
      if (reply?.error) throw new Error(`mesh.presence.get answered ${reply.error.code}: ${reply.error.message}`);
      return reply?.payload ?? null;
    };
    const heartbeat = (subjectNode, signer) => {
      const hb = signEnvelope(createEnvelope({
        type: "emit",
        from: signer.getPublicKey(),
        payload: { node: subjectNode, availability: "online" },
      }), signer);
      nc.publish(`mesh.heartbeat.${subjectNode}`, te.encode(JSON.stringify(hb)));
    };

    const fails = [];
    const notes = [];
    try {
      const node = nkeys.createUser();
      const id = node.getPublicKey();

      // 1. Unknown.
      let before;
      try { before = await lookup(id); } catch (e) {
        const msg = String(e?.message ?? e);
        if (/503|no responders/i.test(msg)) return { status: "fail", detail: "nothing answers mesh.presence.get on this mesh" };
        throw e;
      }
      if (before?.status !== "offline") fails.push(`a node nobody heard from reads ${before?.status ?? "nothing"}, want offline`);
      else if (before?.last_seen != null) fails.push("a node nobody heard from has a last_seen");
      else notes.push("an unknown node reads offline");

      // 2. Its own signed heartbeat.
      const sent = Date.now();
      heartbeat(id, node);
      await nc.flush();
      let after = null;
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        after = await lookup(id);
        if (after?.status === "online") break;
      }
      if (after?.status !== "online") fails.push(`after its own signed heartbeat the node reads ${after?.status ?? "nothing"}, want online`);
      else if (typeof after.last_seen !== "number" || after.last_seen < sent - 5_000) fails.push(`last_seen ${after.last_seen} is not the heartbeat's time`);
      else notes.push("its own signed heartbeat makes it online with a last_seen");

      // 3. A heartbeat for another node, signed by a key it never vouched for.
      const victim = nkeys.createUser().getPublicKey();
      heartbeat(victim, nkeys.createUser());
      await nc.flush();
      await sleep(1500);
      const forged = await lookup(victim);
      if (forged?.status !== "offline") fails.push(`a heartbeat signed by another key made a node read ${forged?.status}`);
      else notes.push("a heartbeat signed by another key changed nothing");
    } finally {
      await nc.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: `${fails.join("; ")}${notes.length ? ` [${notes.join("; ")}]` : ""}` }
      : { status: "pass", detail: notes.join("; ") };
  },
};
