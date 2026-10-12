// A credential answer of the mesh under test, for the tests that read what
// it says (c24, c24b). It asks the node-credential door (SPEC §4.8) for a
// credential for a fresh node key covering the suite's own agent, signed
// exactly as the adapter signs a mint (the same as c20), and revokes that
// credential with the holder's door straight after, so nothing the suite
// minted outlives the test.
import { nkeys } from "../../peering/lib/mesh.mjs";

const te = new TextEncoder();
const sign = (kp, s) => Buffer.from(kp.sign(te.encode(s))).toString("base64");

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

/** The whole answer body of a node-credential mint. Throws env-skip when the
 *  test cannot get one, as c20 does: no API address, no identity, or a door
 *  that will not mint for the suite's agent. */
export async function credentialAnswer(env) {
  if (!env.storefrontBase) throw new Error("env-skip: STOREFRONT_BASE (the mesh's HTTPS API, where the credential doors are) required");
  if (!env.identity?.seed) throw new Error("env-skip: MESH_IDENTITY_FILE (an agent the suite may mint credentials for) required");
  const agentKp = nkeys.fromSeed(te.encode(env.identity.seed));
  const node = nkeys.createUser();
  const nodeId = node.getPublicKey();
  const agentId = agentKp.getPublicKey();
  const ts = Math.floor(Date.now() / 1000);
  const r = await post(env.storefrontBase, "/v1/node-credential", {
    node_id: nodeId,
    ts,
    node_sig: sign(node, `mesh-node-cred-v1:${ts}:${nodeId}:${agentId}`),
    agents: [{ id: agentId, sig: sign(agentKp, `mesh-node-agent-v1:${ts}:${nodeId}:${agentId}`) }],
  });
  if (!r || r.status !== 200 || !r.json?.jwt) {
    // cut-ok: an error message; the status says what happened.
    throw new Error(`env-skip: could not mint the suite's credential (${r ? `${r.status} ${r.text.slice(0, 200)}` : "no answer"})`);
  }
  // Nothing the suite minted outlives the test.
  const ts2 = Math.floor(Date.now() / 1000);
  await post(env.storefrontBase, "/v1/credential/revoke-own", { user_key: nodeId, ts: ts2, sig: sign(node, `mesh-cred-revoke-v1:${ts2}:${nodeId}`) }).catch(() => null);
  return r.json;
}

/** What a URL's scheme says about its binding (SPEC §18.10): "nats", "amqp",
 *  or null for a scheme no binding defined here uses. */
export function bindingOfScheme(url) {
  let scheme;
  try { scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase(); } catch { return null; }
  if (["nats", "tls", "ws", "wss"].includes(scheme)) return "nats";
  if (["amqp", "amqps"].includes(scheme)) return "amqp";
  return null;
}

/** A transport address is well formed when it parses as a URL with a scheme
 *  and a host. */
export function wellFormed(url) {
  if (typeof url !== "string" || !url.trim()) return false;
  try {
    const u = new URL(url);
    return !!u.protocol && !!u.hostname;
  } catch {
    return false;
  }
}
