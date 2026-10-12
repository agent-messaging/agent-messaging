// c20 — live revocation (SPEC §4.8, §4.10, §5.3, §18.2; 2026-09-27,
// docs/live-revocation-plan.md). agentmesh.ai's Trust page says "If your key
// leaks, write to security@agentmesh.ai and we revoke it." This test holds the
// mesh to the two halves of that sentence:
//
//   A. A revoked CREDENTIAL is disconnected within 15 seconds, without a
//      restart, while another credential stays connected. The suite mints two
//      node credentials of its own (fresh node keys, both covering the suite's
//      own agent from MESH_IDENTITY_FILE), connects both, and revokes one with
//      the holder's door, POST /v1/credential/revoke-own, which ends that one
//      connection key and nothing else. The other is revoked the same way at
//      the end, so nothing the suite minted outlives the run.
//   B. A message signed by a revoked AGENT KEY is refused. A fresh key signs
//      its own revocation at POST /v1/agent-key/revoke-own; a request it signs
//      must not reach the agent under test's handler, and must come back
//      UNAUTHORIZED with details.reason agent_key_revoked, while a request from
//      another fresh key does reach the handler.
//
// It needs three things of the mesh under test: the two doors and the
// registry's answer; a broker on the full resolver (docs/our-instance.md
// §6.4), without which part A falls back to refusing renewal and says so; and
// an agent under test whose SDK has the §5.3 receive check. Since step 3 of
// docs/agent-messaging-for-nats-plan.md the doors are the core's
// (services/src/keychain/doors.ts).
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";
import { launchAgent, requireAgentOps } from "../lib/agent-under-test.mjs";
import { cleanSlate, seedFor } from "../lib/test-agents.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sign = (kp, s) => Buffer.from(kp.sign(te.encode(s))).toString("base64");
const WITHIN_MS = 15_000;

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (!res) return null;
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

/** A node credential for a fresh node key covering the suite's own agent,
 *  signed exactly as the adapter signs a mint. */
async function mint(base, agentKp) {
  const node = nkeys.createUser();
  const nodeId = node.getPublicKey();
  const agentId = agentKp.getPublicKey();
  const ts = Math.floor(Date.now() / 1000);
  const r = await post(base, "/v1/node-credential", {
    node_id: nodeId,
    ts,
    node_sig: sign(node, `mesh-node-cred-v1:${ts}:${nodeId}:${agentId}`),
    agents: [{ id: agentId, sig: sign(agentKp, `mesh-node-agent-v1:${ts}:${nodeId}:${agentId}`) }],
  });
  if (!r || r.status !== 200 || !r.json?.jwt) return { error: r ? `${r.status} ${r.text.slice(0, 200)}` : "no answer" };
  return { node, jwt: r.json.jwt };
}

async function revokeOwn(base, node) {
  const userKey = node.getPublicKey();
  const ts = Math.floor(Date.now() / 1000);
  return post(base, "/v1/credential/revoke-own", { user_key: userKey, ts, sig: sign(node, `mesh-cred-revoke-v1:${ts}:${userKey}`) });
}

async function partA(env, fails, notes) {
  if (!env.identity?.seed) throw new Error("env-skip: MESH_IDENTITY_FILE (an agent the suite may mint credentials for) required");
  const agentKp = nkeys.fromSeed(te.encode(env.identity.seed));
  const one = await mint(env.storefrontBase, agentKp);
  const two = await mint(env.storefrontBase, agentKp);
  if (one.error || two.error) throw new Error(`env-skip: could not mint the suite's two credentials (${one.error ?? two.error})`);

  const c1 = await connect({ servers: env.meshWsUrl, authenticator: jwtAuthenticator(one.jwt, one.node.getSeed()), maxReconnectAttempts: 0, timeout: 15_000 });
  const c2 = await connect({ servers: env.meshWsUrl, authenticator: jwtAuthenticator(two.jwt, two.node.getSeed()), maxReconnectAttempts: 0, timeout: 15_000 });
  try {
    await c1.flush();
    await c2.flush();
    const started = Date.now();
    const r = await revokeOwn(env.storefrontBase, one.node);
    if (!r) { fails.push("POST /v1/credential/revoke-own did not answer"); return; }
    if (r.status === 404 && !r.json?.mode) { fails.push(`POST /v1/credential/revoke-own is not on this mesh (${r.status})`); return; }
    if (r.status !== 200) { fails.push(`POST /v1/credential/revoke-own refused: ${r.status} ${r.text.slice(0, 200)}`); return; }
    if (r.json?.mode !== "live") {
      fails.push(`the revocation was not live: ${r.json?.fallback_reason ?? r.json?.note ?? "no reason given"}`);
      return;
    }
    while (!c1.isClosed() && Date.now() - started < WITHIN_MS) await sleep(250);
    const took = Date.now() - started;
    if (!c1.isClosed()) fails.push(`the revoked credential was still connected after ${WITHIN_MS / 1000} seconds`);
    else notes.push(`revoked credential disconnected in ${(took / 1000).toFixed(1)}s`);
    try {
      await c2.flush();
      if (c2.isClosed()) fails.push("the credential that was NOT revoked was disconnected too");
      else notes.push("the other credential stayed connected");
    } catch (e) {
      fails.push(`the credential that was NOT revoked stopped working: ${e?.message ?? e}`);
    }
  } finally {
    await c1.close().catch(() => {});
    await c2.close().catch(() => {});
    // Nothing the suite minted outlives the run.
    await revokeOwn(env.storefrontBase, two.node).catch(() => null);
  }
}

async function partB(env, fails, notes) {
  if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
  requireAgentOps("register", "respond");
  const { AgentMesh } = sdk;
  const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));

  const revokedKp = nkeys.createUser();
  const okKp = nkeys.createUser();
  const ts = Math.floor(Date.now() / 1000);
  const rk = revokedKp.getPublicKey();
  const r = await post(env.storefrontBase, "/v1/agent-key/revoke-own", { agent_key: rk, ts, sig: sign(revokedKp, `mesh-agent-key-revoke-v1:${ts}:${rk}`) });
  if (!r || r.status !== 200) {
    fails.push(`POST /v1/agent-key/revoke-own did not revoke a fresh key: ${r ? `${r.status} ${r.text.slice(0, 200)}` : "no answer"}`);
    return;
  }
  const check = await fetch(`${env.storefrontBase}/v1/key-check/${rk}`, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json()).catch(() => null);
  if (check?.revoked !== true) fails.push("GET /v1/key-check does not report the revoked key as revoked");

  // The receiver registers, so it has a standing, named key
  // (lib/test-agents.mjs), cleared of an earlier run's leftovers first. The
  // two senders never register and stay fresh; the revoked one must be: a
  // key revoked last night cannot be revoked tonight.
  const seedT = seedFor(env, "c20-receiver");
  await cleanSlate(env, "c20-receiver");
  const target = await launchAgent(env, { seed: seedT });
  const sawFrom = (who) => target.handled.filter((h) => h.input?.who === who).length;
  try {
    await target.register({ name: "c20-receiver", visibility: "unlisted", skills: [{ id: "echo", name: "echo", description: "c20" }] });
    await sleep(1000);

    const bad = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: td.decode(revokedKp.getSeed()) });
    let answer = null;
    try { answer = await bad.request(target.agentId, "echo", { who: "revoked" }, { timeout_ms: 8000 }); }
    catch (e) { answer = { threw: e }; }
    await bad.close().catch(() => {});

    const good = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: td.decode(okKp.getSeed()) });
    try { await good.request(target.agentId, "echo", { who: "ok" }, { timeout_ms: 8000 }); }
    catch { /* the point is whether the handler ran */ }
    await good.close().catch(() => {});
    for (let i = 0; i < 40 && !sawFrom("ok"); i++) await sleep(100);
    await sleep(500);

    if (sawFrom("revoked")) fails.push(`a request signed by a revoked key reached the handler (${sawFrom("revoked")} runs)`);
    else notes.push("a revoked key's request never reached the handler");
    const err = answer?.threw ?? answer?.error ?? answer?.payload?.error ?? null;
    const code = err?.code ?? null;
    const reason = err?.details?.reason ?? null;
    if (code !== "UNAUTHORIZED" || reason !== "agent_key_revoked") {
      fails.push(`the revoked sender was not told UNAUTHORIZED / agent_key_revoked (got ${code ?? "no error"}${reason ? ` / ${reason}` : ""})`);
    }
    if (!sawFrom("ok")) fails.push(`a request from a key that is not revoked did not reach the handler. agent output: ${target.log()}`);
  } finally {
    await target.deregister().catch(() => {});
    await target.close().catch(() => {});
    await cleanSlate(env, "c20-receiver");
  }
}

export default {
  id: "c20",
  title: "live revocation: a revoked credential is cut off in seconds, a revoked agent key is refused",
  spec: "§4.8, §4.10, §5.3, §18.2",
  profile: "core",
  async run(env) {
    if (!env.storefrontBase) throw new Error("env-skip: STOREFRONT_BASE (the mesh's HTTPS API, where the credential doors are) required");
    const fails = [];
    const notes = [];
    await partA(env, fails, notes);
    await partB(env, fails, notes);
    return fails.length
      ? { status: "fail", detail: `${fails.join("; ")}${notes.length ? ` [${notes.join("; ")}]` : ""}` }
      : { status: "pass", detail: notes.join("; ") };
  },
};
