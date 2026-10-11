// Ask the deployment to name the standing test agents
// (POST /v1/operator/test-agents/name; services/src/api/conformance-test-agents.ts).
// Keys only, never a seed. Idempotent: an agent already named answers
// "already named", so run.mjs asks every night and the setup script asks once.
import { standingKeys } from "./test-agents.mjs";

/** Returns the deployment's answer, or null when there was nothing to ask or
 *  no way to ask. Never throws. */
export async function nameStandingAgents(env, { quiet = false } = {}) {
  const base = process.env.MESH_API_BASE?.replace(/\/$/, "");
  const key = process.env.MESH_OPERATOR_KEY;
  const agents = standingKeys(env);
  if (!agents.length) {
    if (!quiet) console.log("no standing test agents in MESH_CONFORMANCE_AGENTS_FILE; nothing to name");
    return null;
  }
  if (!base || !key) {
    if (!quiet) console.log("MESH_API_BASE and MESH_OPERATOR_KEY are both needed to ask the deployment to name them");
    return null;
  }
  try {
    const res = await fetch(`${base}/v1/operator/test-agents/name`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ agents }),
      // Seventeen agents, each a lookup and on the first night a claim, a
      // bind and a hold, one after another on the deployment's side.
      signal: AbortSignal.timeout(180_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      console.log(`warning: could not name the standing test agents at ${base}: HTTP ${res.status}`);
      return null;
    }
    const pending = (body.results ?? []).filter((r) => r.outcome !== "already named");
    if (!quiet || pending.length) {
      for (const r of body.results ?? []) console.log(`  ${r.handle} (${r.key_prefix}…): ${r.outcome}`);
    }
    return body;
  } catch (e) {
    console.log(`warning: could not name the standing test agents at ${base}: ${String(e?.message ?? e)}`);
    return null;
  }
}
