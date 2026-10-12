// c01b - durable event subscriptions (§18.6): MESH_EVENTS owns mesh.event.>,
// and a durable subscription is a JetStream durable consumer on it named
// mesh_event_{agent_id}_{first 16 lowercase hex of sha256(pattern)} with
// explicit ack, 30s ack_wait, max_deliver 5. Two properties, both on a real
// broker:
//
//   1. subscribing durably creates (or binds) the derived consumer on
//      MESH_EVENTS with the pinned §18.6 config; the name for the pinned
//      example pattern "billing.invoice_ready" ends in 99397ba4a29eec30,
//      asserted against that literal so a drifted hash in the SDK under test
//      cannot vouch for itself
//   2. an event published while the subscriber is away is delivered on return
//      (at-least-once): the consumer holds interest, so the interest-retained
//      MESH_EVENTS keeps the event, and a second incarnation of the same
//      agent binds the SAME consumer and resumes its cursor
//
// HONESTY: this exercises the SDK module under test in-process (the c01
// idiom), not the AGENTMESH_AGENT_SDK agent - the agent-under-test line
// protocol has no durable-subscribe command yet, so a Rust-agent run still
// vouches only for the module the harness imports here. The consumer name,
// config, and retention are asserted with raw JetStream inspection, so those
// halves are statements about the mesh and the wire, not about the SDK's
// self-report.
import { createHash } from "node:crypto";
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The §18.6 cross-SDK contract, pinned byte-for-byte in both SDKs' tests.
const PINNED_PATTERN = "billing.invoice_ready";
const PINNED_HASH = "99397ba4a29eec30";
const hash16 = (pattern) => createHash("sha256").update(pattern, "utf8").digest("hex").slice(0, 16);

export default {
  id: "c01b",
  title: "durable subscribe: §18.6 consumer on MESH_EVENTS, away events delivered on return",
  spec: "§18.6, §18.3, §6.7",
  profile: "core",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    if (typeof AgentMesh?.connect !== "function") throw new Error("not-validated: SDK under test exports no AgentMesh.connect");

    // The harness's own derivation must agree with the pinned example before
    // it is trusted to predict any consumer name.
    if (hash16(PINNED_PATTERN) !== PINNED_HASH) {
      return { status: "fail", detail: `harness hash derivation disagrees with the pinned §18.6 example: ${hash16(PINNED_PATTERN)}, want ${PINNED_HASH}` };
    }

    // One identity, two incarnations (the c11 idiom): resuming a cursor means
    // nothing unless the agent that comes back is the same agent that left.
    const seedA = td.decode(nkeys.createUser().getSeed());

    // Raw connection for JetStream inspection and cleanup.
    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    const jsm = await nc.jetstreamManager();
    const fails = [];
    const consumers = []; // durable names to delete on the way out
    let a = null;
    let b = null;
    try {
      a = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seedA });
      b = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: td.decode(nkeys.createUser().getSeed()) });
      const idA = a.agentId;

      // (1) the pinned name and the pinned config, on the real stream. A mesh
      // without MESH_EVENTS is a verdict, not a skip: since 0.3 the stream is
      // the one owner of mesh.event.> (§18.3) and durable subscriptions are a
      // published SDK capability.
      let pinnedSub;
      try {
        pinnedSub = await a.subscribe(PINNED_PATTERN, () => {}, { durable: "c01b" });
      } catch (e) {
        return { status: "fail", detail: `durable subscribe failed - MESH_EVENTS not provisioned, or JetStream API refused: ${String(e?.message ?? e).slice(0, 300)}` };
      }
      const wantName = `mesh_event_${idA}_${PINNED_HASH}`;
      consumers.push(wantName);
      if (pinnedSub.durable !== wantName) fails.push(`durable name ${pinnedSub.durable}, want ${wantName} (§18.6 cross-SDK contract)`);
      let info = null;
      try { info = await jsm.consumers.info("MESH_EVENTS", wantName); }
      catch { fails.push(`no durable consumer ${wantName} exists on MESH_EVENTS`); }
      if (info) {
        const cfg = info.config;
        if (cfg.ack_policy !== "explicit") fails.push(`ack_policy=${cfg.ack_policy}, want explicit`);
        if (cfg.ack_wait !== 30_000_000_000) fails.push(`ack_wait=${cfg.ack_wait}, want 30s`);
        if (cfg.max_deliver !== 5) fails.push(`max_deliver=${cfg.max_deliver}, want 5`);
        if (cfg.filter_subject !== `mesh.event.${PINNED_PATTERN}`) fails.push(`filter_subject=${cfg.filter_subject}, want mesh.event.${PINNED_PATTERN}`);
      }
      await pinnedSub.stop(); // ends the loop; §18.6 says the consumer stays

      // (2) at-least-once across an absence, on a unique pattern (no
      // cross-run bleed). Live first, so a red result here is about the
      // absence and not about event delivery in general (c01 covers that).
      const pattern = `c01bx${Date.now().toString(36)}.built`;
      consumers.push(`mesh_event_${idA}_${hash16(pattern)}`);
      const got = [];
      await a.subscribe(pattern, (payload) => got.push(payload), { durable: "c01b" });
      await sleep(600); // consumer creation and interest propagation
      b.emit(pattern, { n: 1 });
      let live = false;
      for (let i = 0; i < 24 && !live; i++) { await sleep(250); live = got.some((p) => p?.data?.n === 1); }
      if (!live) fails.push("a live event did not reach the durable subscriber");

      // Away: the process goes, the consumer (and its interest) stays.
      await a.close();
      a = null;
      await sleep(500);
      b.emit(pattern, { n: 2 });
      await sleep(1000);

      // Return: the same identity re-subscribes the same pattern, binds the
      // SAME consumer, and the held event is delivered.
      a = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seedA });
      const got2 = [];
      await a.subscribe(pattern, (payload) => got2.push(payload), { durable: "c01b" });
      let back = false;
      for (let i = 0; i < 40 && !back; i++) { await sleep(250); back = got2.some((p) => p?.data?.n === 2); }
      if (!back) fails.push("an event published while the subscriber was away was not delivered on return (at-least-once broken)");
    } finally {
      await a?.close().catch(() => {});
      await b?.close().catch(() => {});
      // The consumers are cursors and the SDK rightly never deletes them; the
      // HARNESS does, because these identities will never come back and a
      // leaked consumer holds interest (retention) on the shared stream.
      for (const d of consumers) { try { await jsm.consumers.delete("MESH_EVENTS", d); } catch { /* already gone */ } }
      await nc.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "pinned §18.6 consumer name and config on MESH_EVENTS; live event delivered; away event held and delivered on return" };
  },
};
