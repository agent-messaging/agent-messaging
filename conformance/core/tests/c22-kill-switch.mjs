// c22: the kill switch's public half (SPEC §4.12, §5.3, §9.2; 2026-09-27,
// docs/kill-switch-plan.md). What anyone on the mesh can check without
// pressing anything:
//
//   A. A provider advisory is signed with the agent's own key, and nobody
//      else can issue one in its name. A fresh key signs an advisory about
//      itself and the mesh keeps it; the same statement signed by another key
//      is refused; the advisory is listed publicly and carried on the key
//      check, so a receiver can hold the agent's messages.
//   B. The key check answers in the shape receivers read: `revoked` always,
//      and no `stopped` for a key nobody stopped (a stop is never reported
//      where there is none).
//
// Pressing the switch itself needs a passkey on every press, by design, so
// the suite cannot press it; the rules behind the press are held by the unit
// tests (services/__tests__/unit/kill-switch*.test.ts) and the broker half by
// the Docker test (services/__tests__/integration/kill-switch-broker.test.ts).
//
// EXPECTED TO FAIL against production until the kill-switch branch is
// deployed (the advisory doors and the key check's new fields).
// expectations.json records "fail" until then, as it did for c19 and c20.
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
  id: "c22",
  title: "kill switch: a provider advisory is signed by the agent's own key, listed, and on the key check",
  spec: "§4.12, §5.3, §9.2",
  async run(env) {
    const fails = [];
    const notes = [];
    const base = env.storefrontBase;
    const kp = nkeys.createUser();
    const agent = kp.getPublicKey();
    const statement = {
      agent,
      detail: "Conformance suite c22: a throwaway key issuing an advisory about itself, to prove the door.",
      id: `c22-${Date.now()}`,
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

    const other = nkeys.createUser().getPublicKey();
    const plain = await call(base, "GET", `/v1/key-check/${other}`);
    if (!plain || plain.status !== 200 || plain.json?.revoked !== false) fails.push(`the key check did not answer revoked: false for a fresh key (${plain?.status ?? "no answer"})`);
    else if ("stopped" in (plain.json ?? {})) fails.push("the key check reported a stop for a key nobody stopped");
    else notes.push("a fresh key is not reported stopped");

    return fails.length
      ? { status: "fail", detail: `${fails.join("; ")}${notes.length ? ` [${notes.join("; ")}]` : ""}` }
      : { status: "pass", detail: notes.join("; ") };
  },
};
