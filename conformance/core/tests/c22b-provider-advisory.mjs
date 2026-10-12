// c22b: the kill switch's provider advisory (SPEC §4.12, §5.3; 2026-09-27,
// docs/kill-switch-plan.md). Split from c22 in step 4 of
// docs/agent-messaging-for-nats-plan.md, because SPEC.md §1.6 makes advisories
// deployment-defined: the key check is core (c22), the advisory is AgentMesh's.
//
// A provider advisory is signed with the agent's own key, and nobody else can
// issue one in its name. A fresh key signs an advisory about itself and the
// mesh keeps it; the same statement signed by another key is refused; the
// advisory is listed publicly and carried on the key check, so a receiver can
// hold the agent's messages.
//
// It writes one advisory about a throwaway key each run; that key is never an
// agent anyone deals with.
import { nkeys } from "../../peering/lib/mesh.mjs";

const te = new TextEncoder();
const PREFIX = "agentmesh-provider-advisory-v1\n";

/** RFC 8785 canonical JSON for the flat statement (strings and one null). */
function canonical(o) {
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`).join(",")}}`;
}

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res) return null;
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

export default {
  id: "c22b",
  title: "kill switch: a provider advisory is signed by the agent's own key, listed, and on the key check",
  spec: "§4.12, §5.3, §9.2",
  // Advisories are deployment-defined (SPEC.md §1.6).
  profile: "platform",
  async run(env) {
    if (!env.storefrontBase) throw new Error("env-skip: STOREFRONT_BASE (the mesh's HTTPS API) required");
    const fails = [];
    const notes = [];
    const base = env.storefrontBase;
    const kp = nkeys.createUser();
    const agent = kp.getPublicKey();
    const statement = {
      agent,
      detail: "Conformance suite c22b: a throwaway key issuing an advisory about itself, to prove the door.",
      id: `c22b-${Date.now()}`,
      issued_at: new Date().toISOString(),
      severity: "advisory",
      title: "Conformance check, not a real advisory",
    };
    const sig = Buffer.from(kp.sign(te.encode(PREFIX + canonical(statement)))).toString("base64");

    const thief = nkeys.createUser();
    const forged = Buffer.from(thief.sign(te.encode(PREFIX + canonical(statement)))).toString("base64");
    const refused = await call(base, "POST", "/v1/agent-advisories", { statement, sig: forged });
    if (!refused) fails.push("POST /v1/agent-advisories did not answer");
    else if (refused.status !== 401) fails.push(`an advisory signed by another key was not refused (${refused.status})`);
    else notes.push("an advisory in another key's name was refused");

    const made = await call(base, "POST", "/v1/agent-advisories", { statement, sig });
    if (!made || made.status !== 201) {
      fails.push(`the agent's own advisory was not kept: ${made ? `${made.status} ${made.text.slice(0, 200)}` : "no answer"}`);
    } else {
      notes.push("the agent's own advisory was kept");
      const listed = await call(base, "GET", `/v1/agent-advisories/${agent}`);
      if (!listed?.json?.advisories?.some((a) => a.id === statement.id)) fails.push("the advisory is not listed at GET /v1/agent-advisories/:key");
      const check = await call(base, "GET", `/v1/key-check/${agent}`);
      if (check?.json?.advisory?.id !== statement.id) fails.push("the key check does not carry the advisory");
      else notes.push("the key check carries it");
    }

    return fails.length
      ? { status: "fail", detail: `${fails.join("; ")}${notes.length ? ` [${notes.join("; ")}]` : ""}` }
      : { status: "pass", detail: notes.join("; ") };
  },
};
