// c11 — offline delivery: the mailbox holds, the agent drains, the reply
// comes home. Proves the plans-page promise end to end on a real mesh:
//
//   1. a registered agent gets a mailbox stream with the published bounds
//   2. a request sent while it is offline is captured (sender sees silence,
//      not loss)
//   3. on reconnect the agent drains, handles, and answers to the SENDER's
//      inbox, correlated by in_reply_to (§6.4 queued outcome)
//   4. a live request is answered at the sender's inbox too (§6.5, the 0.3
//      single reply path), handled exactly once (dedup across the live
//      subscription and the buffer consumer, §5.5), and no response data
//      rides the transport reply subject (§18.7)
//   5. deregistration deletes the mailbox (§16.4 lifecycle)
//
// The receiving agent is the AGENT UNDER TEST (../lib/agent-under-test.mjs), so
// this runs against whichever SDK AGENTMESH_AGENT_SDK names. That is the point
// of converting it: the drain is the most delivery-critical thing an SDK does
// and it is invisible from outside — an implementation with no drain at all
// registers, heartbeats, looks healthy, and quietly never answers a single
// message that arrived while it was away. Nothing but a real broker and a real
// second incarnation can tell the difference. Since 0.3 the live path answers
// the same destination the drain does: every respond travels to the sender's
// own inbox, and the reply subject carries delivery-status signals only, so
// step 4 is where a 0.2-era implementation that still answers transport reply
// subjects shows itself.
//
// Everything that is NOT the agent stays on raw NATS here: the sender, the
// JetStream inspection of the mailbox's bounds and lifecycle, and the reply
// capture. Those are the mesh's obligations, and holding them fixed is what
// makes a red result a statement about the SDK.
//
// Needs an SDK with the drain (>= the offline-delivery commit): run with
// AGENTMESH_SDK pointing at a local sdk-typescript build until published.
import { connect, jwtAuthenticator, mailboxes, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";
import { launchAgent, requireAgentOps } from "../lib/agent-under-test.mjs";
import { cleanSlate, seedFor } from "../lib/test-agents.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c11",
  title: "offline delivery: mailbox holds, agent drains, reply comes home",
  spec: "§6.4, §6.5, §16.4, §18.3/18.6/18.7",
  profile: "core",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    // Declared up front so an implementation that cannot come back and answer
    // reports not-validated rather than a pass or a mystery timeout.
    requireAgentOps("register", "respond", "deregister");

    // One identity, two incarnations. The seed is chosen HERE and handed to both
    // launches: a drain means nothing unless the agent that comes back is the
    // same agent that went away, and the harness owning the identity is what
    // makes that true for every implementation.
    //
    // The identity is a standing, named key (lib/test-agents.mjs), because the
    // registry refuses an unnamed agent once MESH_REQUIRE_NAMES is on. That
    // makes this the test a leftover would fool most: last night's mailbox, if
    // its run died before deleting it, would pass step 1 without this run's
    // registration making one, hold messages that pass step 2's capture count,
    // and keep a drain consumer whose position is last night's. So the key
    // starts deregistered with no mailbox (cleanSlate), and every message this
    // test looks for is found by the envelope id it made tonight. The sender
    // only sends and stays fresh.
    const seedA = seedFor(env, "c11-offline-a");
    await cleanSlate(env, "c11-offline-a");
    const kpS = nkeys.createUser();
    const idS = kpS.getPublicKey();

    const incarnations = [];
    const boot = async () => {
      const a = await launchAgent(env, { seed: seedA });
      incarnations.push(a);
      try {
        await a.register({
          name: "c11-offline-a", visibility: "unlisted",
          skills: [{ id: "echo", name: "echo", description: "c11" }],
        });
      } catch (e) {
        await a.close().catch(() => {}); // never leave a child process behind
        throw e;
      }
      return a;
    };
    // Counted across BOTH incarnations, because "handled exactly once" has to
    // mean once on this mesh and not once per process — a message handled by the
    // first incarnation and again by the second is the exact double delivery
    // §5.5 exists to forbid, and per-process counting would call it clean.
    const handledCount = (id) =>
      incarnations.reduce((n, a) => n + a.handled.filter((h) => h.envelope_id === id).length, 0);
    // An out-of-process agent reports what it dispatched on its own channel, so
    // give that report a bounded moment to land before counting. The assertion
    // does not weaken — the count must still be EXACTLY one.
    const settle = async (id, want) => { for (let i = 0; i < 30 && handledCount(id) < want; i++) await sleep(100); };

    // Raw connection for the sender + JetStream inspection.
    const nc = await connect({ servers: env.meshWsUrl, authenticator: auth(), timeout: 15_000, maxReconnectAttempts: 0 });
    // The mailbox as the mesh holds it: a JetStream stream on NATS, a durable
    // queue on RabbitMQ (mailboxes() in peering/lib/mesh.mjs).
    const boxes = mailboxes(nc);
    const inboxS = `mesh.agent.${idS}.inbox`;
    const replies = [];
    const subS = nc.subscribe(inboxS);
    (async () => { for await (const m of subS) { try { replies.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ } } })();

    let a;
    try { a = await boot(); }
    catch (e) { await nc.close().catch(() => {}); throw e; }
    const idA = a.agentId ?? nkeys.fromSeed(te.encode(seedA)).getPublicKey();
    const stream = `MESH_INBOX_${idA}`;
    const fails = [];
    try {
      // (1) mailbox exists with the published bounds
      await sleep(1500); // registry creates it fire-and-forget
      const info = await boxes.info(idA);
      if (!info) return { status: "fail", detail: `no mailbox ${stream} after registration — registry side not deployed?` };
      // BINDING: the bounds are read on NATS only. A client cannot read an
      // AMQP queue's arguments; on RabbitMQ they are the server's, set when
      // the registry makes the queue (storage/rabbitmq/storage.ts).
      const cfg = info.bounds;
      if (cfg) {
        if (cfg.max_bytes !== 25 * 1024 * 1024) fails.push(`max_bytes=${cfg.max_bytes}, want 25MB`);
        if (cfg.max_age !== 7 * 24 * 3600_000 * 1_000_000) fails.push(`max_age=${cfg.max_age}, want 7d`);
        if (cfg.discard !== "old") fails.push(`discard=${cfg.discard}, want old`);
        // Without no_ack, JetStream answers each capture with a pub-ack on the
        // request's reply subject, which §18.7 reserves for delivery-status
        // signals - the capture must be silent.
        if (cfg.no_ack !== true) fails.push("no_ack is not set - the capture answers reply subjects, which §18.7 reserves for delivery-status signals");
      }

      // (2) offline capture: stop A, send, observe silence + capture
      await a.close();
      await sleep(500);
      const reqEnv = signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { n: 1, note: "sent while offline" } },
      }), kpS);
      let liveReply = null;
      try {
        const m = await nc.request(`mesh.agent.${idA}.inbox`, te.encode(JSON.stringify(reqEnv)), { timeout: 3000 });
        liveReply = JSON.parse(td.decode(m.data));
      } catch { /* timeout or no-responders: expected while offline */ }
      if (liveReply && !liveReply.error) fails.push("got a live reply from a closed agent — test rig broken");
      await sleep(300);
      const captured = (await boxes.info(idA))?.messages ?? 0;
      if (captured < 1) fails.push(`offline request not captured (stream has ${captured} messages)`);

      // (3) reconnect: drain, handle, reply lands in S's inbox
      a = await boot();
      let drained = null;
      for (let i = 0; i < 20 && !drained; i++) {
        await sleep(500);
        drained = replies.find((r) => r.in_reply_to === reqEnv.id) ?? null;
      }
      if (!drained) fails.push(`no reply to the offline request arrived at the sender's inbox within 10s. agent output: ${a.log()}`);
      else if (drained.error) fails.push(`drained reply is an error: ${drained.error.message}`);
      // Not just a correlated envelope — the ANSWER. A reply that comes home
      // empty would satisfy in_reply_to and deliver nothing.
      else if (drained.payload?.output?.ok?.n !== 1) fails.push(`drained reply carries no answer: ${JSON.stringify(drained.payload)?.slice(0, 160)}`);
      await settle(reqEnv.id, 1);
      if (handledCount(reqEnv.id) !== 1) fails.push(`offline request handled ${handledCount(reqEnv.id)} times, want 1`);

      // (4) the 0.3 reply path, live: the substantive answer arrives at the
      // SENDER's inbox exactly like the drained one (§6.5), correlated by
      // in_reply_to, and it is handled exactly once despite two delivery paths
      // (§5.5). The reply subject is still set here, deliberately: §18.7
      // reserves it for delivery-status signals (the server's no-responders, a
      // node's queued ack), so proving the cutover means watching it and seeing
      // no response data land there.
      const liveEnv = signEnvelope(createEnvelope({
        type: "request", from: idS, to: idA,
        payload: { skill: "echo", input: { n: 2, note: "sent while live" } },
      }), kpS);
      const replySubject = `_INBOX.c11.${Math.random().toString(36).slice(2)}`;
      const onReply = [];
      const subR = nc.subscribe(replySubject);
      (async () => { for await (const m of subR) { try { onReply.push(JSON.parse(td.decode(m.data))); } catch { /* skip */ } } })();
      nc.publish(`mesh.agent.${idA}.inbox`, te.encode(JSON.stringify(liveEnv)), { reply: replySubject });
      let liveResp = null;
      for (let i = 0; i < 40 && !liveResp; i++) {
        await sleep(250);
        // Never the §6.4a accept: it is a delivery signal, it travels the same
        // inbox, and correlation alone would find it first.
        liveResp = replies.find((r) => r.in_reply_to === liveEnv.id && r?.payload?.status !== "accepted") ?? null;
      }
      if (!liveResp) {
        // A live request to a registered, listening agent that is never
        // answered at the sender's inbox is the §6.5 defect this test exists to
        // see, so it gets a verdict with a diagnosis rather than an unexplained
        // silence. Whether the answer went to the 0.2 destination instead is
        // observable, not a guess: the reply subject is being collected above.
        const wrongPath = onReply.find((r) => r?.in_reply_to === liveEnv.id && r?.payload?.status !== "accepted");
        fails.push(wrongPath
          ? "a LIVE request was answered on its transport reply subject instead of at the sender's inbox: this " +
            "implementation still speaks the 0.2 reply path. Since 0.3 every respond travels to the requester's " +
            "inbox (§6.5) and requesters ignore response data on reply subjects, so every conforming requester of " +
            "this agent waits out its timeout while the answer arrives somewhere it stopped listening"
          : `a live request to a registered, listening agent was never answered at the sender's inbox within 10s. agent output: ${a.log()}`);
      }
      else if (liveResp.error) fails.push(`live request errored: ${liveResp.error.message}`);
      // Not just a correlated envelope - the ANSWER, same rule as step 3.
      else if (liveResp.payload?.output?.ok?.n !== 2) fails.push(`live reply carries no answer: ${JSON.stringify(liveResp.payload)?.slice(0, 160)}`);
      await sleep(2500); // give the buffer consumer time to double-deliver, if it wrongly would
      if (handledCount(liveEnv.id) !== 1) fails.push(`live request handled ${handledCount(liveEnv.id)} times, want exactly 1`);
      // Whatever else happened, response data must not have ridden the reply
      // subject - checked last, after every window above, so a late leak is
      // still seen. Delivery-status signals (an accept, a queued ack) are the
      // only legitimate riders (§18.7); this agent is neither guarded nor
      // attended, so anything substantive here is the 0.2 path leaking.
      const replySubjectData = onReply.filter((r) =>
        (r?.payload?.output !== undefined && r?.payload?.output?.queued !== true) ||
        (r?.payload?.status && r.payload.status !== "accepted"));
      if (replySubjectData.length) fails.push(`response data rode the transport reply subject (${replySubjectData.length} message(s)) - §18.7 reserves it for delivery-status signals`);
      subR.unsubscribe();

      // (5) deregistration deletes the mailbox
      await a.deregister();
      await sleep(1500);
      const gone = (await boxes.info(idA)) === null;
      if (!gone) fails.push("mailbox survived deregistration");
    } finally {
      for (const inc of incarnations) await inc.close().catch(() => {});
      await boxes.remove(idA);
      await nc.close().catch(() => {});
      await cleanSlate(env, "c11-offline-a");
    }

    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "held while offline, drained on return, drained and live answers both at the sender's inbox, nothing substantive on the reply subject, deduped live, mailbox lifecycle clean" };
  },
};
