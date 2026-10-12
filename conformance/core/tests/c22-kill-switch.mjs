// c22: the kill switch's public half (SPEC §4.12, §5.3, §9.2; 2026-09-27,
// docs/kill-switch-plan.md). What anyone on the mesh can check without
// pressing anything: the key check answers in the shape receivers read,
// `revoked` always, and no `stopped` for a key nobody stopped (a stop is never
// reported where there is none). Receivers refusing what a stopped or revoked
// agent signs is in the core profile (SPEC.md §1.6, "Stopping agents"), and
// this is the door they ask.
//
// The provider advisory, which the key check also carries on AgentMesh, is
// deployment-defined (§1.6), so it is c22b, a platform test.
//
// Pressing the switch itself needs a passkey on every press, by design, so
// the suite cannot press it; the rules behind the press are held by the unit
// tests (services/__tests__/unit/kill-switch*.test.ts) and the broker half by
// the Docker test (services/__tests__/integration/kill-switch-broker.test.ts).
import { nkeys } from "../../peering/lib/mesh.mjs";

async function call(base, method, path) {
  const res = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!res) return null;
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

export default {
  id: "c22",
  title: "kill switch: the key check answers revoked, and no stop for a key nobody stopped",
  spec: "§4.12, §5.3, §9.2",
  profile: "core",
  async run(env) {
    if (!env.storefrontBase) throw new Error("env-skip: STOREFRONT_BASE (the mesh's HTTPS API, where the key check is) required");
    const other = nkeys.createUser().getPublicKey();
    const plain = await call(env.storefrontBase, "GET", `/v1/key-check/${other}`);
    if (!plain || plain.status !== 200 || plain.json?.revoked !== false) {
      return { status: "fail", detail: `the key check did not answer revoked: false for a fresh key (${plain?.status ?? "no answer"})` };
    }
    if ("stopped" in (plain.json ?? {})) return { status: "fail", detail: "the key check reported a stop for a key nobody stopped" };
    return { status: "pass", detail: "a fresh key is not reported revoked or stopped" };
  },
};
