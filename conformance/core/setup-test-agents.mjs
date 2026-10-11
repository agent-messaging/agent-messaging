#!/usr/bin/env node
// One-time setup for the core suite's standing test agents
// (docs/no-anonymous-agents-plan.md items 12 and 15; lib/test-agents.mjs).
//
//   node setup-test-agents.mjs keys
//       Make the keys. Writes MESH_CONFORMANCE_AGENTS_FILE (default
//       ~/.agentmesh/conformance-agents.json, mode 600) with one key for each
//       name in STANDING_TEST_AGENTS (lib/test-agents.mjs). A key already in
//       the file is kept, so running it on the file from item 12 adds the new
//       names and leaves c10-guest, c12-pipe, c13-inbox and c15-stream as they
//       are; running it twice changes nothing. Prints the public keys and the
//       names they will have. Touches no network.
//
//   node setup-test-agents.mjs name
//       Ask the deployment at MESH_API_BASE to name them
//       <name>.test@agentmesh.ai and hold them on the platform account, with
//       the operator automation key in MESH_OPERATOR_KEY (the `ci` scope the
//       nightly already holds). Sends public keys only. Safe to repeat: an
//       agent already named is left alone, and a name bound to another key is
//       refused rather than moved.
//
// Then the operator installs the file where the suite reads its credentials:
// keep it at ~/.agentmesh/conformance-agents.json for local runs, and paste its
// contents into the repository secret MESH_CONFORMANCE_AGENTS for the nightly.
// The nightly asks the deployment to name them before every run, so if the
// `name` step is skipped the first nightly does it.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { nkeys } from "../peering/lib/mesh.mjs";
import { STANDING_TEST_AGENTS, TEST_ANCHOR } from "./lib/test-agents.mjs";
import { nameStandingAgents } from "./lib/name-test-agents.mjs";

const FILE = process.env.MESH_CONFORMANCE_AGENTS_FILE ?? join(homedir(), ".agentmesh", "conformance-agents.json");
const cmd = process.argv[2];

function readFile() {
  if (!existsSync(FILE)) return { agents: {} };
  const doc = JSON.parse(readFileSync(FILE, "utf8"));
  if (!doc || typeof doc.agents !== "object") throw new Error(`${FILE} has no "agents" object; fix or move it, this will not overwrite it`);
  return doc;
}

if (cmd === "keys") {
  const doc = readFile();
  let made = 0;
  for (const name of STANDING_TEST_AGENTS) {
    if (doc.agents[name]?.seed) continue;
    const kp = nkeys.createUser();
    doc.agents[name] = { seed: new TextDecoder().decode(kp.getSeed()), public_key: kp.getPublicKey() };
    made++;
  }
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(FILE, 0o600); } catch { /* not every file system has modes */ }
  console.log(`${made ? `made ${made} key(s)` : "every key was already there"}; ${FILE}`);
  for (const name of STANDING_TEST_AGENTS) {
    console.log(`  ${name}.${TEST_ANCHOR}  ${doc.agents[name].public_key}`);
  }
  console.log("\nKeep this file private: it holds seeds. Next: install it for the nightly (repository secret MESH_CONFORMANCE_AGENTS), then run `node setup-test-agents.mjs name` or let the nightly name them.");
} else if (cmd === "name") {
  const { loadEnv } = await import("../peering/lib/env.mjs");
  process.env.MESH_CONFORMANCE_AGENTS_FILE ??= FILE;
  const env = loadEnv();
  const out = await nameStandingAgents(env);
  if (!out) process.exit(1);
  console.log(out.ok ? "\nall standing test agents are named" : "\nnot all are named; the lines above say why. Run this again once that is fixed.");
  process.exit(out.ok ? 0 : 1);
} else {
  console.log("usage: node setup-test-agents.mjs keys | name");
  process.exit(2);
}
