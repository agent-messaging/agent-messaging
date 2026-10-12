// The run loop both suites share (core/run.mjs, peering/run.mjs) and the
// profile runner (../run.mjs) uses.
//
// Every test declares which conformance profile it belongs to (SPEC.md §1.6):
//
//   core      what every Agent Messaging server must pass. A server that runs
//             only the core (Agent Messaging for NATS, a self-hosted mesh)
//             runs these as its health check.
//   platform  a deployment-defined part that AgentMesh offers (§1.6, "What is
//             deployment-defined"): human sign-in, provider advisories, the
//             HTTPS describe door, federation, AgentMesh's own retired routes.
//   naming    a test of Agent Naming registrars, not of a messaging server. It
//             belongs to Agent Naming's own suite and runs here until it moves.
//
// `--profile core|platform|naming|all` picks which run. The suite runners
// default to `all`, which is what the nightly has always run; the profile
// runner defaults to `core`.
//
// The discipline (do not soften it): a red test is either a code defect or a
// spec defect, decided explicitly and in writing. Editing a test to make it
// pass without citing which of the two it was is how a constitution dies.
//
// Verdicts: pass / fail / error / env-skip (prerequisite not configured) /
// pending-peer / not-validated. The last is an env-skip that does NOT get to
// be a skip: a credential file was CONFIGURED but unreadable or empty, so the
// tests that would have exercised it could not run. "Passes and env-skips
// only" must never be satisfiable by breaking a secret, so not-validated is
// non-green and --ci exits 1 on it — the operator asked for credentials and
// did not get them. A test throws `not-validated: <reason>` to say the same
// about an SDK it was asked to use and cannot (core/lib/agent-under-test.mjs).
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export const PROFILES = ["core", "platform", "naming"];

const CONFORMANCE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The specification version under test, read from SPEC.md beside the suite
 *  (the monorepo and the public protocol repository both keep it there). */
export function specVersion() {
  try {
    const text = readFileSync(join(CONFORMANCE, "..", "SPEC.md"), "utf8");
    return text.match(/^\*\*Version:\*\*\s*([0-9][^\s]*)/m)?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Read the shared command line: --only, --ci, --update and --profile. */
export function parseArgs(argv, { defaultProfile }) {
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const profile = at("--profile") ?? defaultProfile;
  if (profile !== "all" && !PROFILES.includes(profile)) {
    console.error(`unknown profile "${profile}"; use one of ${[...PROFILES, "all"].join(", ")}`);
    process.exit(2);
  }
  return {
    only: at("--only"),
    ci: argv.includes("--ci"),
    update: argv.includes("--update"),
    profile,
    flag: (name) => argv.includes(name),
  };
}

/** What a run says it tested, printed above the board. */
export function profileLine(profile) {
  const version = specVersion();
  if (profile === "core") return `Agent Messaging ${version}, core profile (SPEC.md §1.6)`;
  if (profile === "all") return `Agent Messaging ${version}, every profile: core, platform (AgentMesh's deployment-defined parts) and naming`;
  if (profile === "platform") return `Agent Messaging ${version}, AgentMesh's deployment-defined parts (SPEC.md §1.6)`;
  return `Agent Messaging ${version}, Agent Naming registrar tests (SPEC-NAMING.md)`;
}

/** Load every test module of the given suites, in name order per suite. */
async function loadTests(suites) {
  const out = [];
  for (const suite of suites) {
    const testsDir = join(suite.dir, "tests");
    const files = readdirSync(testsDir).filter((f) => f.endsWith(".mjs")).sort();
    for (const f of files) {
      const mod = (await import(pathToFileURL(join(testsDir, f)).href)).default;
      if (!PROFILES.includes(mod.profile)) {
        throw new Error(`${suite.name}/tests/${f} declares no profile (want one of ${PROFILES.join(", ")})`);
      }
      out.push({ suite, mod });
    }
  }
  return out;
}

/**
 * Run the tests of `suites` that belong to `opts.profile`, print the board,
 * and apply --update or --ci against each suite's expectations.json.
 *
 *   suites   [{ name, dir }]: each suite's folder holds tests/ and
 *            expectations.json
 *   env      what loadEnv returned
 *   header   lines to print above the board (what was tested)
 *   after    awaited after the board and before the verdict (the core
 *            runner's AgentMesh operator calls)
 *
 * Exits the process with the --ci verdict; otherwise returns the results.
 */
export async function runSuites({ suites, env, opts, header = [], after = null }) {
  const tests = await loadTests(suites);
  const results = [];

  for (const { suite, mod } of tests) {
    if (opts.only && mod.id !== opts.only) continue;
    if (!opts.only && opts.profile !== "all" && mod.profile !== opts.profile) continue;
    let r;
    const t0 = Date.now();
    try {
      r = await mod.run(env);
    } catch (e) {
      const msg = String(e?.message ?? e);
      r = msg.startsWith("env-skip:")
        ? { status: "env-skip", detail: msg.slice("env-skip:".length).trim() }
        : msg.includes("not-validated:")
          ? { status: "not-validated", detail: msg.slice(msg.indexOf("not-validated:") + "not-validated:".length).trim() }
          : { status: "error", detail: msg };
    }
    // An env-skip whose named variable had a CONFIGURED-but-unreadable
    // credential behind it is not a skip — the operator asked for that
    // credential. Upgrade it to not-validated so it cannot hide in the green.
    if (r.status === "env-skip") {
      const varName = Object.keys(env.credentialProblems ?? {}).find((v) => String(r.detail ?? "").includes(v));
      if (varName) r = { status: "not-validated", detail: `${varName} is configured but unusable (${env.credentialProblems[varName]}) — this test needed it and did not run` };
    }
    results.push({ suite, id: mod.id, title: mod.title, spec: mod.spec, profile: mod.profile, ms: Date.now() - t0, ...r });
  }

  // Say what was tested. A board that does not name the artifact under test
  // cannot be cited as evidence about any particular artifact.
  console.log(opts.only ? `Agent Messaging ${specVersion()}, one test: ${opts.only}` : profileLine(opts.profile));
  for (const line of header) console.log(line);
  console.log("");

  const ICON = { pass: "✓", fail: "✗", "env-skip": "○", "pending-peer": "…", error: "!", "not-validated": "‼" };
  for (const r of results) {
    const tag = r.profile === "core" ? "" : ` (${r.profile})`;
    console.log(`${ICON[r.status] ?? "?"} ${r.id}${tag}  ${r.title}  [${r.spec}]  ${r.status.toUpperCase()}${r.ms > 1500 ? ` (${(r.ms / 1000).toFixed(1)}s)` : ""}`);
    if (r.detail) console.log(`    ${String(r.detail).split("\n").join("\n    ")}`);
  }
  const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`\n${results.length} tests: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}`);

  // not-validated is called out apart from skips: these tests were supposed to
  // run (credentials were configured) and did not. A board with any of these
  // is not green, whatever the pass count says.
  const notValidated = results.filter((r) => r.status === "not-validated");
  if (notValidated.length) {
    console.error(`\nNOT VALIDATED — something the operator asked for (a credential, an SDK) could not be used; these tests did not run and this run cannot vouch for what they cover:`);
    for (const r of notValidated) console.error(`  ${r.id}  ${r.detail}`);
  }

  if (after) await after(results);

  const expectationsOf = (suite) => join(suite.dir, "expectations.json");
  if (opts.update) {
    // Only the tests this run ran are rewritten. A run of one profile, or of
    // one test, leaves every other recorded status as it was.
    for (const suite of suites) {
      const ran = results.filter((r) => r.suite === suite);
      if (!ran.length) continue;
      const path = expectationsOf(suite);
      const before = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      for (const r of ran) before[r.id] = r.status;
      const ids = Object.keys(before).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      writeFileSync(path, JSON.stringify(Object.fromEntries(ids.map((id) => [id, before[id]])), null, 2) + "\n");
      console.log(`${suite.name}/expectations.json updated from this run (${ran.length} test(s))`);
    }
  } else if (opts.ci) {
    const expected = new Map();
    for (const suite of suites) expected.set(suite, JSON.parse(readFileSync(expectationsOf(suite), "utf8")));
    const was = (r) => expected.get(r.suite)?.[r.id];
    // A regression is a test that WAS pass and is now actually worse — fail or
    // error. "env-skip"/"pending-peer" mean the prerequisite (the registrar rig,
    // a real peer) was absent, so the test could not be evaluated; that is not a
    // regression, just an unavailable environment. "not-validated" is neither:
    // it is reported above and gates the exit code on its own.
    const NOT_EVALUATED = new Set(["env-skip", "pending-peer", "not-validated"]);
    const regressions = results.filter((r) => was(r) === "pass" && r.status !== "pass" && !NOT_EVALUATED.has(r.status));
    const unevaluated = results.filter((r) => was(r) === "pass" && NOT_EVALUATED.has(r.status) && r.status !== "not-validated");
    const improvements = results.filter((r) => was(r) && was(r) !== "pass" && r.status === "pass");
    for (const r of regressions) console.error(`REGRESSION: ${r.id} was pass, now ${r.status} — ${r.detail ?? ""}`);
    for (const r of unevaluated) console.log(`not evaluated: ${r.id} (${r.status}) — prerequisite absent; run the rig/peer to verify`);
    for (const r of improvements) console.log(`IMPROVED: ${r.id} now passes — update expectations.json (--update) to lock it in`);
    // not-validated fails CI regardless of what expectations.json records:
    // fixing it means fixing the credential file, never updating the baseline.
    process.exit(regressions.length || notValidated.length ? 1 : 0);
  }
  return results;
}
