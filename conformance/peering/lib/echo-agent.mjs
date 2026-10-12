// The agent t02 and t05 send to.
//
// With ECHO_TARGET set, that agent: a handle resolved at REGISTRAR, or an
// agent key used as it is. This is how AgentMesh runs them, against a fleet
// agent whose adapter answers `__diag_echo__` and `describe`.
//
// In the core profile with no ECHO_TARGET, the suite starts its own: the
// reference adapter (mesh-adapter.mjs) in inbox mode, on a fresh key, with the
// suite's durable creds and MESH_WS_URL, the same way c13 starts one. Its
// daemon answers both skills itself, so no command or model is involved. The
// sender the test signs as (MESH_IDENTITY_FILE) is put on its roster, so
// admission lets the request through and a missing reply means the mesh or
// the agent dropped it, not that a stranger was held. A core run then depends
// on no agent anyone else runs.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentId } from "./env.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AGENT_KEY = /^U[A-Z2-7]{55}$/;
const ADAPTER = process.env.RESOLVER_MJS ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "mesh-adapter", "mesh-adapter.mjs");

/**
 * The agent to send to, as { agentId, own, stop }. `own` says whether the
 * suite started it; `stop` ends it (a no-op for someone else's agent).
 * `allow` lists sender keys to put on an agent the suite starts.
 */
export async function echoAgent(env, name, { allow = [] } = {}) {
  if (env.echoTarget) {
    const agentId = AGENT_KEY.test(env.echoTarget) ? env.echoTarget : await resolveAgentId(env.registrar, env.echoTarget);
    return { agentId, own: false, stop: async () => {} };
  }
  if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required to start the suite's echo agent");
  if (!existsSync(ADAPTER)) throw new Error("env-skip: ECHO_TARGET is unset and mesh-adapter.mjs was not found to start an echo agent (set RESOLVER_MJS)");

  const state = mkdtempSync(join(tmpdir(), `${name}-echo-`));
  const credsFile = join(state, "mesh.creds");
  writeFileSync(credsFile,
    `-----BEGIN NATS USER JWT-----\n${env.creds.jwt}\n------END NATS USER JWT------\n\n` +
    `-----BEGIN USER NKEY SEED-----\n${env.creds.seed}\n------END USER NKEY SEED------\n`,
    { mode: 0o600 });
  const childEnv = { ...process.env, MESH_ADAPTER_STATE: state, MESH_CREDS_FILE: credsFile, MESH_URL: env.meshWsUrl, PAN_REGISTRAR: env.registrar };
  const child = spawn(process.execPath, [ADAPTER, "start", "--inbox", "--name", `${name}-echo`], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  const stop = async () => {
    child.kill();
    await sleep(200);
    try { rmSync(state, { recursive: true, force: true }); } catch { /* a temp folder */ }
  };

  let agentId = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (child.exitCode !== null) break;
    if (/^listening/m.test(log)) { agentId = log.match(/\b(U[A-Z2-7]{55})\b/)?.[1] ?? null; break; }
  }
  if (!agentId) {
    await stop();
    throw new Error(`the suite's echo agent never came up listening in 30s. output: ${log.slice(-400)}`);
  }
  for (const key of allow) {
    await new Promise((resolve) => {
      const cli = spawn(process.execPath, [ADAPTER, "contacts", "allow", key, `${name} sender`], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      cli.on("close", resolve);
      cli.on("error", resolve);
    });
  }
  return { agentId, own: true, stop };
}
