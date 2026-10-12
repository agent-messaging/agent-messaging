// c21: a signed-out place can no longer act (SPEC §4.11; 2026-09-27,
// docs/one-agent-many-places-plan.md).
//
// A person's one agent is signed in in many places. Signing one out must end
// that place, at once, and no other. This test holds a deployment to that:
//
//   A. The fixture (conformance/delegation.json): the delegation and the
//      approval verify against the agent key over their tagged bytes and not
//      over the bare canonical JSON; the place request verifies against the
//      place key only; the direct envelope does NOT verify as an ordinary
//      envelope from the agent (a receiver that does not implement §4.11
//      refuses it, never accepts it).
//   B. Live: two computers are signed in as the test account's agent, each
//      with a key of its own, through the deployment's own doors (the signed
//      ask, the account's approval, the signed collect). Both act. One is
//      signed out on the Signed in on door. It is refused on its next request
//      and its key reads revoked at the key-check door (§4.10), while the
//      other still acts. The other is signed out at the end, so nothing the
//      suite signed in outlives the run.
//
// Part B needs a signed-in session of an account that has an agent and no
// passkey (the approval would otherwise ask for the passkey, which a suite
// cannot give): MESH_CONFORMANCE_SESSION and MESH_CONFORMANCE_ACCOUNT, read by
// exact name. Without them part B env-skips. EXPECTED TO FAIL against
// production until the one-agent-many-places branch is deployed;
// expectations.json records "fail" until then.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const te = new TextEncoder();
const b64 = (kp, s) => Buffer.from(kp.sign(te.encode(s))).toString("base64");
const verifyUrl = (key, bytes, sig) => {
  try { return nkeys.fromPublic(key).verify(te.encode(bytes), new Uint8Array(Buffer.from(sig, "base64url"))); } catch { return false; }
};

function partA(fails) {
  const fx = JSON.parse(readFileSync(join(HERE, "..", "..", "delegation.json"), "utf8"));
  const { canonicalJSON, verifyEnvelopeSig } = sdk;
  const check = (name, block, key) => {
    const { sig, ...rest } = block.signed;
    if (canonicalJSON(rest) !== block.canonical) fails.push(`${name}: the canonical JSON does not reproduce`);
    if (!verifyUrl(key, block.signed_bytes_prefix + block.canonical, sig)) fails.push(`${name}: the agent's signature does not verify over the tagged bytes`);
    if (verifyUrl(key, block.canonical, sig)) fails.push(`${name}: the signature verifies over the bare JSON, so the tag buys nothing`);
  };
  if (fx.delegation.signed_bytes_prefix !== "agentmesh-delegation-v1\n") fails.push("the delegation tag is not agentmesh-delegation-v1");
  check("delegation", fx.delegation, fx.identities.agent);
  check("approval", fx.approval, fx.identities.agent);
  const pr = fx.place_request;
  if (!verifyUrl(fx.identities.place, pr.signed_bytes_prefix + canonicalJSON(pr.request), pr.sig)) fails.push("the place request does not verify against the place key");
  if (verifyUrl(fx.identities.agent, pr.signed_bytes_prefix + canonicalJSON(pr.request), pr.sig)) fails.push("the place request verifies against the agent key");
  if (typeof verifyEnvelopeSig === "function" && verifyEnvelopeSig(fx.direct_envelope.envelope)) {
    fails.push("a direct delegated envelope verifies as an ordinary envelope from the agent");
  }
}

async function call(base, path, init = {}) {
  const r = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r) return { status: 0, body: null };
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Sign a computer in through the deployment's own doors. */
async function signIn(base, account, session, machine) {
  const kp = nkeys.createUser();
  const key = kp.getPublicKey();
  const ts = new Date().toISOString();
  const ask = await call(base, "/v1/place-requests", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, ts, sig: b64(kp, `mesh-place-ask-v1:${ts}:${key}`), machine, always_on: false }),
  });
  if (ask.status !== 200 || !ask.body?.id) throw new Error(`the deployment did not take a place request (${ask.status} ${ask.body?.error ?? ""})`);
  const approve = await call(base, `/v1/accounts/${encodeURIComponent(account)}/place-requests/${ask.body.id}/approve`, {
    method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: "{}",
  });
  if (approve.body?.agentmesh_code === "STEP_UP_REQUIRED") throw new Error("env-skip: the conformance account has a passkey, so approving asks for it; use an account with none");
  if (approve.status !== 200) throw new Error(`the approval was refused (${approve.status} ${approve.body?.error ?? ""})`);
  const cts = new Date().toISOString();
  const got = await call(base, `/v1/place-requests/${ask.body.id}?ts=${encodeURIComponent(cts)}&sig=${encodeURIComponent(b64(kp, `mesh-place-collect-v1:${cts}:${ask.body.id}:${key}`))}`);
  if (got.status !== 200 || !got.body?.place) throw new Error(`the computer could not collect its sign-in (${got.status})`);
  return { kp, key, place: got.body.place };
}

async function act(base, p) {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const ts = new Date().toISOString();
  const nonce = Math.random().toString(36).slice(2);
  const req = { delegation: p.place, ts, nonce, act: body };
  const sig = Buffer.from(p.kp.sign(te.encode("agentmesh-place-request-v1\n" + sdk.canonicalJSON(req)))).toString("base64url");
  return call(base, "/v1/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `AgentMesh-Place ${p.place}`, "x-agentmesh-ts": ts, "x-agentmesh-nonce": nonce, "x-agentmesh-sig": sig },
    body: JSON.stringify(body),
  });
}

async function signOut(base, account, session, place) {
  return call(base, `/v1/accounts/${encodeURIComponent(account)}/signed-in-on/${encodeURIComponent(place)}/sign-out`, {
    method: "POST", headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: "{}",
  });
}

async function partB(env, fails, notes) {
  const session = process.env.MESH_CONFORMANCE_SESSION;
  const account = process.env.MESH_CONFORMANCE_ACCOUNT;
  if (!session || !account) throw new Error("env-skip: MESH_CONFORMANCE_SESSION and MESH_CONFORMANCE_ACCOUNT (a signed-in account with an agent and no passkey) required for the live part");
  const base = env.storefrontBase.replace(/\/$/, "");
  const one = await signIn(base, account, session, "conformance-c21-one");
  let two = null;
  try {
    two = await signIn(base, account, session, "conformance-c21-two");
    for (const [name, p] of [["one", one], ["two", two]]) {
      const r = await act(base, p);
      if (r.status !== 200) fails.push(`computer ${name} could not act while signed in (${r.status})`);
    }
    const out = await signOut(base, account, session, one.place);
    if (out.status !== 200) fails.push(`signing out was refused (${out.status} ${out.body?.error ?? ""})`);
    const after = await act(base, one);
    if (after.status !== 401) fails.push(`the signed-out computer still acts (${after.status})`);
    const key = await call(base, `/v1/key-check/${one.key}`);
    if (key.body?.revoked !== true) fails.push("the signed-out computer's key does not read revoked at the key-check door");
    const other = await act(base, two);
    if (other.status !== 200) fails.push(`signing one computer out stopped the other (${other.status})`);
    notes.push("signed out in one request; the other place kept working");
  } finally {
    await signOut(base, account, session, one.place).catch(() => null);
    if (two) await signOut(base, account, session, two.place).catch(() => null);
  }
}

export default {
  id: "c21",
  title: "one agent, many places: a signed-out place can no longer act, and the others can",
  spec: "§4.11, §4.10",
  // A signed-in person, account approval and the hosted MCP door; §4.11 is
  // deployment-defined (SPEC.md §1.6).
  profile: "platform",
  async run(env) {
    const fails = [];
    const notes = [];
    partA(fails);
    try {
      await partB(env, fails, notes);
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.startsWith("env-skip:")) {
        if (fails.length) return { status: "fail", detail: fails.join("; ") };
        throw err;
      }
      fails.push(msg);
    }
    return fails.length
      ? { status: "fail", detail: `${fails.join("; ")}${notes.length ? ` [${notes.join("; ")}]` : ""}` }
      : { status: "pass", detail: notes.join("; ") || "the fixture holds" };
  },
};
