// Core conformance harness (same discipline as ../peering/run.mjs; the run
// loop, the verdicts and the expectations are in ../lib/harness.mjs).
//
//   node run.mjs                  run everything, print the board
//   node run.mjs --profile core   only the tests of one profile (core,
//                                 platform; default all). For the core
//                                 profile across both suites, ../run.mjs.
//   node run.mjs --only c05       run one test
//   node run.mjs --ci             compare against expectations.json: exit 1 on
//                                 any REGRESSION (a test whose recorded status
//                                 was "pass" that no longer passes) or any
//                                 NOT-VALIDATED result. Improvements are
//                                 reported with a prompt to update the baseline.
//   node run.mjs --update         rewrite this run's entries in expectations.json
//   node run.mjs --agentmesh-operator
//                                 also ask the AgentMesh deployment at
//                                 MESH_API_BASE to name the standing test agents
//                                 before the run and to leave this run's keys
//                                 out of its daily digest after it. Needs
//                                 MESH_OPERATOR_KEY. These are AgentMesh
//                                 operator doors, so nothing else asks them.
//
// The same verdict as a broken credential, not-validated, covers an SDK that
// cannot run a test: AGENTMESH_AGENT_SDK names which implementation plays the
// agent under test (see lib/agent-under-test.mjs), and if the one the operator
// asked for cannot exercise a test's agent-side behaviour, that test reports
// not-validated. A test throws `not-validated: <reason>` to say so, exactly as
// it throws `env-skip: <reason>` for an absent prerequisite.
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadEnv } from "../peering/lib/env.mjs";
import { sdkUnderTest } from "../peering/lib/sdk.mjs";
import { agentSdkLabel, mintedAgentKeys } from "./lib/agent-under-test.mjs";
import { standingKeys } from "./lib/test-agents.mjs";
import { nameStandingAgents } from "./lib/name-test-agents.mjs";
import { nkeys } from "../peering/lib/mesh.mjs";
import { parseArgs, runSuites } from "../lib/harness.mjs";

/**
 * Tell the deployment which agent keys this run used, so its daily digest can
 * leave them out of the growth counts (services/src/api/daily-stats.ts). It
 * needs the same operator key the workflow uses to report the verdict, and
 * does nothing without one: a local run pointed at someone else's mesh has no
 * business declaring anything there. Never fails the run — a digest that
 * counts one night's agents is a smaller wrong than a red nightly over it.
 */
async function declareTestAgents(env) {
  const base = process.env.MESH_API_BASE?.replace(/\/$/, "");
  const key = process.env.MESH_OPERATOR_KEY;
  const keys = new Set(mintedAgentKeys);
  // The standing test agents (lib/test-agents.mjs) are the harness's too.
  for (const { key: k } of standingKeys(env)) keys.add(k);
  // c10's rooms creator is a stable key handed to the harness, not minted by
  // it; the rooms it makes are the harness's too.
  if (env.roomsCreatorSeed) {
    try { keys.add(nkeys.fromSeed(new TextEncoder().encode(env.roomsCreatorSeed)).getPublicKey()); } catch { /* an unusable seed already env-skipped c10 */ }
  }
  if (!base || !key || !keys.size) return;
  try {
    const res = await fetch(`${base}/v1/operator/test-agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ agents: [...keys] }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await res.text()).slice(0, 200);
    console.log(res.ok
      ? `\ndeclared ${keys.size} test agent key(s) to ${base}: ${text}`
      : `\nwarning: could not declare test agents to ${base}: HTTP ${res.status} ${text}`);
  } catch (e) {
    console.log(`\nwarning: could not declare test agents to ${base}: ${String(e?.message ?? e)}`);
  }
}

const HERE = dirname(fileURLToPath(import.meta.url));
const opts = parseArgs(process.argv.slice(2), { defaultProfile: "all" });
const operator = opts.flag("--agentmesh-operator");

const env = loadEnv({ profile: opts.profile });
// The standing test agents are named once (setup-test-agents.mjs); asking
// again is a no-op, and asking before the tests means the first night after
// the keys are installed registers named agents, not unnamed ones. Never
// fails the run, and does nothing without MESH_API_BASE and MESH_OPERATOR_KEY.
if (operator) await nameStandingAgents(env, { quiet: true });

await runSuites({
  suites: [{ name: "core", dir: HERE }],
  env,
  opts,
  // The agent under test can be a different implementation from the SDK
  // module the harness itself imports, so both are named.
  header: [`SDK under test — ${sdkUnderTest()}`, `Agent under test — ${agentSdkLabel()}`],
  after: operator ? () => declareTestAgents(env) : null,
});
