// Thin mesh access for tests: a raw NATS connection with the operator's
// durable creds, plus signed-envelope request helpers. Raw on purpose — the
// suite tests the wire contract, not the SDK's conveniences.
import { connect, jwtAuthenticator, nkeyAuthenticator, createInbox } from "nats.ws";
import nkeys from "nkeys.js";
import { createEnvelope, signEnvelope } from "./sdk.mjs";

// Re-exported for sibling suites (conformance/core) that share this lib —
// bare "nats.ws"/"nkeys.js" specifiers resolve only from THIS directory's
// node_modules.
export { connect, jwtAuthenticator, nkeyAuthenticator, nkeys };

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
