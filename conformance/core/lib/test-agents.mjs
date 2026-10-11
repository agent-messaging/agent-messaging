// The core suite's standing test agents (docs/no-anonymous-agents-plan.md
// items 12 and 15).
//
// Every agent a test REGISTERS needs a verified name once the platform
// enforces the naming rule (MESH_REQUIRE_NAMES): the registry refuses the
// rest. Item 12 gave the four that outlive their test (c10's invited guest and
// the adapter nodes of c12, c13 and c15) one key each; item 15 did the same
// for every other agent the suite registers. Each has one key, kept with the
// suite's credentials, and one name, `<name>.test@agentmesh.ai`, claimed once
// by the setup script (../setup-test-agents.mjs) and asked for again, as a
// no-op, by run.mjs.
//
// A key that lives across runs carries whatever the last run left on it: a
// registration, an offline mailbox and its consumer, an admission guard. So a
// test that registers a standing agent calls cleanSlate() before it starts and
// again when it ends (see below). Keys a test only SENDS from stay fresh: the
// naming rule is checked where an agent registers or a credential is minted,
// never on a send, and several tests need a sender nobody has seen before
// (c07's anonymous sender, c20's revoked key).
//
// Where the keys live: MESH_CONFORMANCE_AGENTS_FILE (default
// ~/.agentmesh/conformance-agents.json), and in the nightly the repository
// secret MESH_CONFORMANCE_AGENTS written to that path. Shape:
//
//   { "agents": { "c10-guest": { "seed": "SU…", "public_key": "U…" }, … } }
//
// Without the file a test falls back to a key minted for the run and says so,
// which works exactly as before while the rule is off.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";

/** The names, in the same order as services/src/api/conformance-test-agents.ts. */
export const STANDING_TEST_AGENTS = [
  // item 12: the agents that outlive their test
  "c10-guest", "c12-pipe", "c13-inbox", "c15-stream",
  // item 15: every other agent the suite registers
  "c03-target", "c04-target", "c05-streamer", "c06-presence",
  "c07-guarded", "c07-guard-probe", "c07-known-sender",
  "c09-target", "c11-offline-a",
  "c14-service", "c14-interactive", "c14-undeclared",
  "c20-receiver",
];

/** The anchor they are named under. */
export const TEST_ANCHOR = "test@agentmesh.ai";

/** The stable identity for `name`, or null when the file does not carry it. */
export function standingIdentity(env, name) {
  const a = env?.testAgents?.[name];
  if (!a?.seed) return null;
  let publicKey;
  try { publicKey = nkeys.fromSeed(new TextEncoder().encode(a.seed)).getPublicKey(); } catch { return null; }
  // A file whose seed and key disagree is a broken secret, not a key to use.
  if (a.public_key && a.public_key !== publicKey) {
    throw new Error(`not-validated: MESH_CONFORMANCE_AGENTS_FILE entry "${name}" names ${String(a.public_key).slice(0, 12)}… but its seed is ${publicKey.slice(0, 12)}…`);
  }
  return { seed: a.seed, publicKey, handle: `${name}.${TEST_ANCHOR}` };
}

/** The seed a test should connect as: the standing one, else a fresh key. */
export function seedFor(env, name) {
  return standingIdentity(env, name)?.seed ?? new TextDecoder().decode(nkeys.createUser().getSeed());
}

/** Give an adapter's state directory the standing identity for `name`, so the
 *  adapter starts as that agent instead of minting a key. Returns whether it
 *  did; false means the adapter will mint one, as before. */
export function plantAdapterIdentity(stateDir, env, name) {
  const id = standingIdentity(env, name);
  if (!id) return false;
  writeFileSync(
    join(stateDir, "identity.json"),
    JSON.stringify({ public_key: id.publicKey, seed: id.seed, created_at: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  return true;
}

/** Every standing key the file carries, for run.mjs to declare and name. */
export function standingKeys(env) {
  const out = [];
  for (const name of STANDING_TEST_AGENTS) {
    try {
      const id = standingIdentity(env, name);
      if (id) out.push({ name, key: id.publicKey });
    } catch { /* a broken entry already failed its test as not-validated */ }
  }
  return out;
}

const te = new TextEncoder();

/**
 * Clear what an earlier run may have left on a standing agent's key, so this
 * run starts where a fresh key would have: no registration, no offline mailbox
 * (the `MESH_INBOX_<key>` stream, and with it the drain's consumer, whose
 * leftovers the next registration would drain into the handler a test is
 * counting), and, with `unguard`, no admission guard (c07). A test calls it
 * before it registers and again when it ends, so a run that died half way
 * does not hand its state to the next night.
 *
 * Signed with the agent's own key, as the agent would: the registry and the
 * admission service act only on a verified `from`. Does nothing for a key
 * minted for this run (nothing can be left on it) or without MESH_CREDS_FILE.
 * Never throws: a failed clean-up is the state we started in, and the test's
 * own assertions say whether it mattered.
 */
export async function cleanSlate(env, name, { unguard = false } = {}) {
  let id;
  try { id = standingIdentity(env, name); } catch { return; } // the test reports a broken entry itself
  if (!id || !env?.creds) return;
  let nc;
  try {
    nc = await connect({
      servers: env.meshWsUrl,
      authenticator: jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed)),
      timeout: 15_000,
      maxReconnectAttempts: 0,
    });
    const kp = nkeys.fromSeed(te.encode(id.seed));
    const signed = (type, payload) => te.encode(JSON.stringify(signEnvelope(createEnvelope({ type, from: id.publicKey, payload }), kp)));
    // Deregistering takes the manifest, the mailbox and the guard entry with it
    // (services/src/registry/handlers/deregister.ts). An agent that is not
    // registered answers with an error, which is the clean state.
    await nc.request("mesh.registry.deregister", signed("register", { deregister: true }), { timeout: 5000 }).catch(() => null);
    // The registry clears the guard's durable entry, not the admission
    // service's live relay for the key; only the agent's own unguard does. A
    // request, not a publish, so it is applied before this returns and cannot
    // land after the test's own guard.
    if (unguard) await nc.request("mesh.admission.unguard", signed("request", {}), { timeout: 5000 }).catch(() => null);
    // The registry removes the mailbox in the background; delete it here too
    // so a leftover cannot outlive this call.
    const jsm = await nc.jetstreamManager();
    await jsm.streams.delete(`MESH_INBOX_${id.publicKey}`).catch(() => null);
  } catch { /* best effort */ } finally {
    await nc?.close().catch(() => {});
  }
}
