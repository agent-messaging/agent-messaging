// Take a test's adapter off the registry before the test stops it.
//
// A conformance test that starts a real adapter against the live mesh leaves
// a registration behind when it only kills the process: an adapter stopping
// on SIGTERM does not deregister (a restart must not drop an agent from
// discovery), and the reaper keeps an agent that never declared its
// availability for as long as its node's attestation lasts. The nightly run
// left one c13-inbox and one c15-stream a day, sixty of them by 2026-09-26,
// half of every discover. So the test says goodbye as the adapter would: a
// deregister signed with the key the adapter wrote into its state folder.
//
// Best effort: a failure is returned, never thrown, so it cannot turn a
// passing test into a failing one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nkeys } from "../../peering/lib/mesh.mjs";
import { createEnvelope, signEnvelope } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();

/** Deregister the identity in `<stateDir>/identity.json`, over `nc`. */
export async function deregisterAdapter(nc, stateDir) {
  try {
    const id = JSON.parse(readFileSync(join(stateDir, "identity.json"), "utf8"));
    const kp = nkeys.fromSeed(te.encode(id.seed));
    const env = signEnvelope(createEnvelope({ type: "register", from: id.public_key, payload: { deregister: true } }), kp);
    await nc.request("mesh.registry.deregister", te.encode(JSON.stringify(env)), { timeout: 5000 });
    return null;
  } catch (err) {
    return err?.message ?? String(err);
  }
}
