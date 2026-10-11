// c06 — presence expires, registration survives (§9.5, §9.6): a live agent
// reads online in discovery; when its node goes silent, presence flips
// offline within the staleness window — but the manifest is untouched and
// the agent remains discoverable by description. The split that makes a
// sleeping laptop a normal state, proven on the live mesh.
import { jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";
import { cleanSlate, seedFor } from "../lib/test-agents.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c06",
  title: "presence expires on silence; the manifest does not",
  spec: "§8.4, §9.5, §9.6",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;
    const fresh = () => td.decode(nkeys.createUser().getSeed());

    // A standing, named key (lib/test-agents.mjs). The same key every night
    // means last night's registration and presence could still be there if
    // that run died before its clean-up, and a manifest already "offline"
    // would pass the flip below without this run proving anything. So the key
    // starts deregistered, and the first assertion (online while live) is
    // what shows this run's registration took. The observer only reads and
    // stays fresh.
    const seedA = seedFor(env, "c06-presence");
    await cleanSlate(env, "c06-presence");
    let a = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seedA });
    await a.register({ name: "c06-presence", visibility: "public", skills: [{ id: "echo", name: "echo", description: "c06" }] });
    const idA = a.agentId;

    const observer = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: fresh() });
    const fails = [];
    // Discovery by id (§9.3 `agent_ids`), not an open listing. The agent is a
    // named Mesh Internal Test Agent, and those are never listed in open
    // discovery (services/src/registry/unlisted.ts); asked for by id, the
    // registry still answers from the same stored manifest with the same
    // presence join (§9.3) and the same availability filter (§9.6), so what
    // this test proves is unchanged: presence flips on silence, the manifest
    // does not. A registry that ignores `agent_ids` returns the open listing,
    // which the find below reads just the same.
    const findIn = async (query) => {
      const r = await observer.discover({ ...(query ?? {}), agent_ids: [idA] });
      const list = r?.agents ?? r ?? [];
      return list.find?.((m) => m.id === idA) ?? null;
    };
    try {
      await sleep(1500);
      const live = await findIn({});
      if (!live) fails.push("registered agent not discoverable while live");
      else if (live.availability && live.availability !== "online") fails.push(`live agent reads ${live.availability}, want online`);

      // Silence: close the connection (heartbeats stop with it).
      await a.close();
      a = null;

      // Wait past the staleness window (2x heartbeat interval + margin).
      // Poll rather than guess: up to 2.5 minutes for presence to flip.
      let flipped = null;
      for (let i = 0; i < 15; i++) {
        await sleep(10_000);
        const now = await findIn({});
        if (now && now.availability && now.availability !== "online") { flipped = now.availability; break; }
        if (!now) { flipped = "absent-from-unfiltered-discovery"; break; }
      }
      if (!flipped) fails.push("presence never left online after 150s of silence");
      if (flipped === "absent-from-unfiltered-discovery") fails.push("silent agent vanished from UNFILTERED discovery — the manifest was touched by missed heartbeats");

      // The availability filter drops it; the description query still finds it.
      const onlineOnly = await observer.discover({ availability: "online", agent_ids: [idA] }).catch(() => null);
      const stillListedOnline = (onlineOnly?.agents ?? onlineOnly ?? []).find?.((m) => m.id === idA);
      if (stillListedOnline) fails.push("silent agent still passes availability:online filter");
      const byDescription = await findIn({});
      if (!byDescription) fails.push("silent agent lost its registration (manifest should outlive presence)");
    } finally {
      // Clean up the registration.
      try {
        const a2 = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seedA });
        await a2.register({ name: "c06-presence", visibility: "unlisted", skills: [] }).catch(() => {});
        await a2.deregister().catch(() => {});
        await a2.close().catch(() => {});
      } catch { /* best effort */ }
      await observer.close().catch(() => {});
      if (a) await a.close().catch(() => {});
      await cleanSlate(env, "c06-presence");
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "online while heartbeating; offline after silence; dropped by availability filter; manifest intact throughout" };
  },
};
