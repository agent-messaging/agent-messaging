// The profile runner: one board for one conformance profile (SPEC.md §1.6),
// across both suites (core/tests and peering/tests).
//
//   node run.mjs                     the core profile: what every Agent
//                                    Messaging server must pass, and the
//                                    health check of a mesh that runs only
//                                    the core (the Agent Messaging Server)
//   node run.mjs --profile platform  AgentMesh's deployment-defined parts
//   node run.mjs --profile naming    the Agent Naming registrar tests
//   node run.mjs --profile identity  bring your own identity (§4.13 to §4.16),
//                                    the parts the mesh says it offers
//   node run.mjs --profile all       everything
//   node run.mjs --only c05          one test, whatever its profile
//   node run.mjs --ci                exit 1 on a REGRESSION against either
//                                    suite's expectations.json, or on any
//                                    NOT-VALIDATED result
//   node run.mjs --update            rewrite this run's entries in each
//                                    suite's expectations.json
//
// The core profile takes no agentmesh.ai default: set MESH_WS_URL (and
// MESH_CREDS_FILE, STOREFRONT_BASE and the rest, README.md) to the mesh under
// test. Install the suites' dependencies first: `npm install` in peering/, and
// `npm ci` in ../mesh-adapter for the adapter tests.
//
// The suite runners (core/run.mjs, peering/run.mjs) run their own folder, all
// profiles by default; the nightly uses them.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnv } from "./peering/lib/env.mjs";
import { sdkUnderTest } from "./peering/lib/sdk.mjs";
import { agentSdkLabel } from "./core/lib/agent-under-test.mjs";
import { parseArgs, runSuites } from "./lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const opts = parseArgs(process.argv.slice(2), { defaultProfile: "core" });
const env = loadEnv({ profile: opts.profile });

await runSuites({
  suites: [
    { name: "core", dir: join(HERE, "core") },
    { name: "peering", dir: join(HERE, "peering") },
  ],
  env,
  opts,
  header: [`Mesh under test — ${env.meshWsUrl}`, `SDK under test — ${sdkUnderTest()}`, `Agent under test — ${agentSdkLabel()}`],
});
