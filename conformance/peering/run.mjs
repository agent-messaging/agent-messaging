// Peering conformance harness (the run loop, the verdicts and the
// expectations are in ../lib/harness.mjs, shared with ../core/run.mjs).
//
//   node run.mjs                  run everything, print the board
//   node run.mjs --profile core   only the tests of one profile (core,
//                                 platform, naming; default all). For the
//                                 core profile across both suites, ../run.mjs.
//   node run.mjs --only t05       run one test
//   node run.mjs --ci             compare against expectations.json: exit 1 on
//                                 any REGRESSION (a test whose recorded status
//                                 was "pass" that no longer passes) or any
//                                 NOT-VALIDATED result. Improvements are
//                                 reported with a prompt to update the baseline.
//   node run.mjs --update         rewrite this run's entries in expectations.json
//
// The discipline (do not soften it): a red test is either a code defect or a
// spec defect, decided explicitly and in writing. Editing a test to make it
// pass without citing which of the two it was is how a constitution dies.
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { loadEnv } from "./lib/env.mjs";
import { sdkUnderTest } from "./lib/sdk.mjs";
import { parseArgs, runSuites } from "../lib/harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const opts = parseArgs(process.argv.slice(2), { defaultProfile: "all" });
const env = loadEnv({ profile: opts.profile });

await runSuites({
  suites: [{ name: "peering", dir: HERE }],
  env,
  opts,
  header: [`SDK under test — ${sdkUnderTest()}`],
});
