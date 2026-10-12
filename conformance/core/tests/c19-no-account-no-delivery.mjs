// c19 — no account, no delivery (SPEC §4.1, §4.8, 2026-09-27). The claim on
// agentmesh.ai is "No anonymous agents. Every agent registers with the
// AgentMesh authority before it can join." This test tries every way a
// caller with NO account could come by a working connection, and so reach a
// customer agent's inbox, and requires each one to fail:
//
//   1. the no-signup door, POST /v1/guest: no credential. AgentMesh retired
//      it and answers 410; a server that never had it answers 404, and both
//      are accepted (step 4 of docs/agent-messaging-for-nats-plan.md);
//   2. a self-made nkey with no JWT at all: the broker refuses the connection;
//   3. a user JWT signed by a self-made account key: the broker refuses it;
//   4. the node-credential door, POST /v1/node-credential, asked for keys that
//      no account holds and no verified name is bound to: refused, no JWT.
//
// Nothing here needs a credential of the suite's own, on purpose: the caller
// being modelled has none. A broker that is unreachable is an environment
// problem (error), not evidence either way.
//
// Step 4 FAILS at a deployment where MESH_REQUIRE_NAMES is off
// (docs/no-anonymous-agents-plan.md item 6): with the setting off, the door
// still grants on proof of key possession alone, which is the gap this test
// exists to show. expectations.json records pass, so such a run reports a
// regression.
import { connect, jwtAuthenticator, nkeyAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createHash } from "node:crypto";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAuthViolation = (s) => /authorization|authentication|permissions? violation|user.*(not|in)valid/i.test(s);

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** A NATS user JWT (v2) for `userPub`, signed by a freshly made account key
 *  that no operator ever signed. Shape-correct, so a refusal is a refusal of
 *  the ISSUER, not of a malformed token. */
function selfSignedUserJwt(userPub) {
  const account = nkeys.createAccount();
  const header = b64url(te.encode(JSON.stringify({ typ: "JWT", alg: "ed25519-nkey" })));
  const claims = {
    iat: Math.floor(Date.now() / 1000),
    iss: account.getPublicKey(),
    name: "c19-self-made",
    sub: userPub,
    nats: { pub: {}, sub: {}, subs: -1, data: -1, payload: -1, type: "user", version: 2 },
  };
  claims.jti = createHash("sha256").update(JSON.stringify(claims)).digest("base64").replace(/=+$/, "");
  const payload = b64url(te.encode(JSON.stringify(claims)));
  const sig = b64url(account.sign(te.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${sig}`;
}

/** Try a connection; "refused" when the broker says no at the handshake or
 *  right after it, "accepted" when it stays up and flushes traffic. */
async function probe(servers, authenticator) {
  let nc;
  try {
    nc = await connect({ servers, authenticator, timeout: 15_000, maxReconnectAttempts: 0 });
  } catch (e) {
    const msg = `${e?.code ?? ""} ${e?.message ?? e}`;
    if (isAuthViolation(msg)) return { refused: true, detail: msg.trim() };
    return { refused: null, detail: msg.trim() };
  }
  const violations = [];
  (async () => {
    for await (const s of nc.status()) {
      const t = `${s.data ?? ""} ${s.error ?? ""}`;
      if (isAuthViolation(t)) violations.push(t.trim());
    }
  })().catch(() => {});
  try {
    nc.publish("mesh.event.conformance.c19", te.encode("{}"));
    await nc.flush().catch(() => {});
    await sleep(2_500);
    if (nc.isClosed() || violations.length) return { refused: true, detail: violations[0] ?? "closed after connect" };
    return { refused: false, detail: "the connection stayed up and flushed traffic" };
  } finally {
    await nc.close().catch(() => {});
  }
}

/** POST /v1/node-credential for a fresh node key and a fresh agent key,
 *  signed exactly as the adapter signs a real mint. */
async function mintForStrangers(base) {
  const node = nkeys.createUser();
  const agent = nkeys.createUser();
  const nodeId = node.getPublicKey();
  const agentId = agent.getPublicKey();
  const ts = Math.floor(Date.now() / 1000);
  const sign = (kp, s) => Buffer.from(kp.sign(te.encode(s))).toString("base64");
  const body = {
    node_id: nodeId,
    ts,
    node_sig: sign(node, `mesh-node-cred-v1:${ts}:${nodeId}:${agentId}`),
    agents: [{ id: agentId, sig: sign(agent, `mesh-node-agent-v1:${ts}:${nodeId}:${agentId}`) }],
  };
  const res = await fetch(`${base}/v1/node-credential`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res) return null;
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}

export default {
  id: "c19",
  title: "no account, no delivery: no credential path without an account",
  spec: "§4.1, §4.8, §6.2",
  profile: "core",
  async run(env) {
    const fails = [];
    const notes = [];

    // 1. The no-signup door: retired (410) or never there (404).
    if (!env.storefrontBase) throw new Error("env-skip: STOREFRONT_BASE (the mesh's HTTPS API, where the credential doors are) required");
    const g = await fetch(`${env.storefrontBase}/v1/guest`, { method: "POST", signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (!g) throw new Error("env-skip: the API at STOREFRONT_BASE did not answer");
    const gText = await g.text().catch(() => "");
    if (g.status !== 410 && g.status !== 404) fails.push(`/v1/guest answered ${g.status}, not 410 or 404`);
    if (/"(jwt|seed)"\s*:/.test(gText)) fails.push("/v1/guest carried a credential");

    // 2. A self-made nkey, no JWT.
    const kp = nkeys.createUser();
    const bare = await probe(env.meshWsUrl, nkeyAuthenticator(kp.getSeed()));
    if (bare.refused === null) throw new Error(`could not probe the broker: ${bare.detail}`);
    if (!bare.refused) fails.push(`a self-made nkey with no JWT connected (${bare.detail})`);
    else notes.push("self-made nkey refused");

    // 3. A JWT signed by a self-made account.
    const jwt = selfSignedUserJwt(kp.getPublicKey());
    const forged = await probe(env.meshWsUrl, jwtAuthenticator(jwt, kp.getSeed()));
    if (forged.refused === null) throw new Error(`could not probe the broker: ${forged.detail}`);
    if (!forged.refused) fails.push(`a user JWT from a self-made account connected (${forged.detail})`);
    else notes.push("self-signed JWT refused");

    // 4. The node-credential door, for keys nobody holds.
    const m = await mintForStrangers(env.storefrontBase);
    if (!m) {
      notes.push("/v1/node-credential did not answer");
    } else if (m.status === 200 && /"jwt"\s*:/.test(m.text)) {
      fails.push("/v1/node-credential minted a working credential for keys no account holds (MESH_REQUIRE_NAMES is off at this deployment)");
    } else if (m.status === 501) {
      notes.push("/v1/node-credential: minting not configured here");
    } else {
      notes.push(`/v1/node-credential refused strangers (${m.status})`);
    }

    void td;
    return fails.length
      ? { status: "fail", detail: `${fails.join("; ")}${notes.length ? ` [${notes.join("; ")}]` : ""}` }
      : { status: "pass", detail: notes.join("; ") };
  },
};
