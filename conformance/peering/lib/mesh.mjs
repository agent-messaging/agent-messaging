// Thin mesh access for tests: a raw connection with the operator's durable
// creds, plus signed-envelope request helpers. Raw on purpose — the suite
// tests the wire contract, not the SDK's conveniences.
//
// The connection is the binding's own (docs/agent-messaging-server-plan.md,
// step 10): on a NATS mesh (nats://, ws://, wss://) it is the NATS client,
// exactly as before; on a mesh on the RabbitMQ binding (amqp://, amqps://) it
// is the SDK's AMQP transport behind the same handful of calls the tests make
// (publish with a reply, subscribe, request, flush, close, isClosed, closed,
// status). What exists on one binding only (JetStream) throws a
// `binding-specific:` error on the other, and `bindingOf` says which a test
// is talking to.
import { connect as natsConnect, jwtAuthenticator, nkeyAuthenticator, createInbox } from "nats.ws";
import nkeys from "nkeys.js";
import { createEnvelope, signEnvelope, sdkModule } from "./sdk.mjs";

// Re-exported for sibling suites (conformance/core) that share this lib —
// bare "nats.ws"/"nkeys.js" specifiers resolve only from THIS directory's
// node_modules.
export { jwtAuthenticator, nkeyAuthenticator, nkeys };

/** The binding an address speaks: "amqp" or "nats". */
export function bindingOf(servers) {
  const list = Array.isArray(servers) ? servers : [servers];
  return list.length && list.every((s) => /^amqps?:\/\//i.test(String(s ?? ""))) ? "amqp" : "nats";
}

/** Connect to the mesh under test on its own binding (see the header). */
export async function connect(opts) {
  if (bindingOf(opts.servers) === "nats") return natsConnect(opts);
  return amqpConnect(opts);
}

/** The SDK's AMQP transport, in the shape of the NATS connection the tests use. */
async function amqpConnect(opts) {
  if (typeof sdkModule.connectTransport !== "function") {
    throw new Error("not-validated: the SDK under test has no AMQP transport (connectTransport); point AGENTMESH_SDK at a build that has one");
  }
  // No credential: present a login the broker must refuse (c16), rather than
  // refusing on this side.
  const auth = opts.authenticator ? { authenticator: opts.authenticator } : { auth: { user: "anonymous", pass: "no-credential" } };
  let t;
  try {
    t = await sdkModule.connectTransport({ servers: opts.servers, ...auth, reconnect: false, name: "conformance" });
  } catch (e) {
    // The NATS client's words for a refused login, so c16 reads both the same.
    const m = String(e?.message ?? e);
    throw Object.assign(new Error(/ACCESS.REFUSED|403|refused/i.test(m) ? `Authorization Violation: ${m}` : m), { code: /ACCESS.REFUSED|403/i.test(m) ? "AUTHORIZATION_VIOLATION" : e?.code });
  }
  let resolveClosed;
  const closedP = new Promise((r) => (resolveClosed = r));
  const watch = setInterval(() => { if (t.isClosed) { clearInterval(watch); resolveClosed(); } }, 200);
  watch.unref?.();
  const natsError = (e) => {
    const code = e?.code === "TRANSPORT_NO_RESPONDERS" ? "503" : e?.code === "TRANSPORT_TIMEOUT" ? "TIMEOUT" : e?.code;
    return Object.assign(new Error(code === "503" ? `503 no responders: ${e.message}` : e.message), { code });
  };
  return {
    binding: "amqp",
    info: { max_payload: t.maxPayload },
    publish: (subject, data, o) => t.publish(subject, data ?? new Uint8Array(0), o?.reply ? { reply: o.reply } : undefined),
    subscribe(subject, o) {
      const sub = t.raw.subscribe(subject);
      const max = o?.max;
      if (!max) return sub;
      let n = 0;
      return {
        unsubscribe: () => sub.unsubscribe(),
        getSubject: () => subject,
        isClosed: () => sub.isClosed(),
        async *[Symbol.asyncIterator]() {
          for await (const m of sub) {
            yield m;
            if (++n >= max) { sub.unsubscribe(); return; }
          }
        },
      };
    },
    async request(subject, data, o) {
      try { return await t.request(subject, data, { timeout: o?.timeout ?? 5000 }); }
      catch (e) { throw natsError(e); }
    },
    flush: () => t.flush(),
    close: async () => { await t.close(); resolveClosed(); },
    drain: async () => { await t.drain(); resolveClosed(); },
    closed: () => closedP,
    isClosed: () => t.isClosed,
    status: () => t.status(),
    async jetstreamManager() { throw new Error("binding-specific: JetStream exists on the NATS binding only"); },
    jetstream() { throw new Error("binding-specific: JetStream exists on the NATS binding only"); },
    transport: t,
  };
}

/**
 * An agent's mailbox, as the mesh holds it, on either binding: on NATS its
 * JetStream stream, on RabbitMQ its durable queue. `info` is null when there
 * is none; `bounds` (age, size, discard) is read on NATS only, because AMQP
 * does not show a queue's arguments to a client.
 */
export function mailboxes(nc) {
  if (nc.binding === "amqp") {
    return {
      binding: "amqp",
      async info(agentId) {
        const q = await nc.transport.queueInfo(`MESH_INBOX_${agentId}`);
        return q ? { messages: q.messages, bounds: null } : null;
      },
      async remove() { /* the registry removes it at deregistration */ },
    };
  }
  let jsmP = null;
  const jsm = () => (jsmP ??= nc.jetstreamManager());
  return {
    binding: "nats",
    async info(agentId) {
      try {
        const i = await (await jsm()).streams.info(`MESH_INBOX_${agentId}`);
        return { messages: i.state.messages, bounds: { max_bytes: i.config.max_bytes, max_age: i.config.max_age, discard: i.config.discard, no_ack: i.config.no_ack } };
      } catch { return null; }
    },
    async remove(agentId) { try { await (await jsm()).streams.delete(`MESH_INBOX_${agentId}`); } catch { /* gone */ } },
  };
}

const te = new TextEncoder();
const td = new TextDecoder();

export async function meshConnect(env) {
  if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
  return connect({
    servers: env.meshWsUrl,
    authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
    timeout: 15_000,
    maxReconnectAttempts: 0,
  });
}

/** Send raw envelope bytes and wait for the SUBSTANTIVE reply (§6.4a).
 *
 *  WHY THIS EXISTS. Since the accept signal shipped (2026-07-27), a
 *  non-interactive agent answers a request TWICE: an immediate
 *  `{status:"accepted"}` ack so the caller's wait is no longer blind, then the
 *  real respond. `nc.request()` resolves on the FIRST message it sees, so a
 *  hand-rolled request has been reading the ack and finding no output in it
 *  ever since — c03 and c12 both did, and both looked like product failures
 *  ("control request failed", "command never saw the message on stdin") while
 *  the product was behaving exactly as specified.
 *
 *  The suite deliberately speaks the wire rather than using the SDK's
 *  `request()`, which already implements this. That is the right call — but it
 *  means the wire contract has to be implemented HERE, once, rather than
 *  rediscovered by every test that sends an envelope.
 *
 *  Returns the first reply whose `payload.status` is not `"accepted"`. A queued
 *  ack (`REQUEST_QUEUED`, an interactive agent) IS substantive: nothing further
 *  arrives on this channel, so returning it lets a caller assert on it.
 */
export async function requestSubstantive(nc, subject, bytes, { timeout = 30_000 } = {}) {
  const inbox = createInbox();
  const sub = nc.subscribe(inbox, { max: 8 });
  nc.publish(subject, bytes, { reply: inbox });

  let timer;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no substantive reply within ${timeout}ms`)), timeout);
  });
  const collect = (async () => {
    for await (const m of sub) {
      let env;
      try { env = JSON.parse(td.decode(m.data)); } catch { continue; }
      // Skip the accept and keep waiting; anything else is the answer.
      if (env?.payload?.status === "accepted") continue;
      return env;
    }
    throw new Error("reply subscription ended before a substantive reply arrived");
  })();

  try {
    return await Promise.race([collect, expiry]);
  } finally {
    clearTimeout(timer);
    sub.unsubscribe();
  }
}

export function identityKeypair(env) {
  if (!env.identity?.seed) throw new Error("env-skip: MESH_IDENTITY_FILE (adapter identity) required");
  return nkeys.fromSeed(te.encode(env.identity.seed));
}

/** Build and sign a request envelope from this machine's durable identity. */
export function signedRequest(env, { to, skill, input = null, meta = undefined }) {
  const kp = identityKeypair(env);
  const from = env.identity.public_key;
  const envelope = createEnvelope({
    type: "request",
    from,
    to,
    payload: { skill, input },
    ...(meta !== undefined ? { meta } : {}),
  });
  return signEnvelope(envelope, kp);
}

/** Send a request to an agent inbox and await the answer where 0.3 delivers
 *  it: the SENDER's own inbox, correlated by in_reply_to (§6.4). The accept
 *  signal is skipped, since it is delivery status and not the answer. Returns
 *  the parsed reply envelope, or null when nothing correlated arrives inside
 *  the timeout, which callers read as "not delivered or refused". */
export async function inboxRequest(nc, agentId, envelope, timeoutMs = 10_000) {
  const sub = nc.subscribe(`mesh.agent.${envelope.from}.inbox`);
  const deadline = setTimeout(() => sub.unsubscribe(), timeoutMs);
  try {
    nc.publish(`mesh.agent.${agentId}.inbox`, te.encode(JSON.stringify(envelope)));
    for await (const m of sub) {
      let reply;
      try { reply = JSON.parse(td.decode(m.data)); } catch { continue; }
      if (reply?.in_reply_to !== envelope.id) continue;
      if (reply?.payload?.status === "accepted" && !reply.error) continue;
      return reply;
    }
    return null; // the timeout closed the subscription with nothing correlated
  } finally {
    clearTimeout(deadline);
    sub.unsubscribe();
  }
}
