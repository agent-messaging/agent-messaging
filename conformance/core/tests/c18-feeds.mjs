// c18 — feeds (§6.6a, §18.3): the owner-rooted publish/subscribe round-trip
// and the current-value lookup, live. The lookup assertion is a REGRESSION
// GUARD for a bug found on the reference deployment the day feeds shipped:
// MESH_FEED bound `mesh.feed.>`, which also captures the three-token lookup
// subject `mesh.feed.get` — and a captured request-reply gets JetStream's
// publish acknowledgment sent to its reply subject, racing the responder's
// real answer and winning. The stream must bind the four-token grammar
// (`mesh.feed.*.*`), and this test notices if anyone ever rebinds the prefix.
//
// The PUBLISHER's agent identity is the credential's own key, deliberately:
// §6.6a's transport grant is `mesh.feed.<own key>.*`, so a narrow credential
// can only broadcast as itself — using it is also testing it.
import { connect, jwtAuthenticator, nkeys } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk, verifyEnvelopeSig } from "../../peering/lib/sdk.mjs";

const te = new TextEncoder();
const td = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c18",
  title: "feeds: owner-rooted publish delivers; the current-value lookup answers a real envelope",
  spec: "§6.6a, §18.3",
  profile: "core",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;

    // Publisher AS the credential's key; subscriber as a bystander identity.
    const pub = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: env.creds.seed });
    const subber = await AgentMesh.connect(env.meshWsUrl, {
      authenticator: auth(),
      nkeySeed: td.decode(nkeys.createUser().getSeed()),
    });
    const fails = [];
    try {
      const topic = `c18x${Date.now().toString(36)}`; // single token — feed grammar
      const got = [];
      subber.subscribeFeed(pub.agentId, topic, (payload, envelope) => got.push({ payload, envelope }));
      await sleep(600); // subscription interest propagation

      pub.publishFeed(topic, { n: 1 }, { kind: "state" });
      await sleep(2000); // delivery + the platform state-writer's fold

      if (got.length !== 1) {
        fails.push(
          `subscriber got ${got.length} deliveries, want 1 — if 0 everywhere, the credential likely ` +
            `predates the feed grants (mesh.feed.<own key>.* / mesh.feed.*.*): re-mint ` +
            `MESH_CONFORMANCE_CREDS from the current template`,
        );
      } else {
        const { payload, envelope } = got[0];
        if (payload?.topic !== topic) fails.push(`payload.topic=${payload?.topic}, want ${topic}`);
        if (payload?.kind !== "state") fails.push(`payload.kind=${payload?.kind}, want state`);
        if (payload?.data?.n !== 1) fails.push(`payload.data=${JSON.stringify(payload?.data)}, want {n:1}`);
        if (envelope?.from !== pub.agentId) fails.push("feed envelope's from is not the owner");
        if (!verifyEnvelopeSig(envelope)) fails.push("feed envelope signature does not verify");
      }

      // The regression guard: the lookup must answer a REAL stored envelope.
      const current = await subber.feedValue(pub.agentId, topic);
      if (!current) {
        fails.push(
          "current-value lookup (mesh.feed.get) answered nothing — if MESH_FEED binds mesh.feed.> " +
            "instead of mesh.feed.*.*, the stream's pub-ack races the responder and wins (SPEC §18.3)",
        );
      } else {
        if (current.from !== pub.agentId) fails.push("stored envelope's from is not the owner");
        if (current.payload?.data?.n !== 1) fails.push(`stored data=${JSON.stringify(current.payload?.data)}, want {n:1}`);
      }
    } finally {
      await pub.close().catch(() => {});
      await subber.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : {
          status: "pass",
          detail: "owner-rooted publish delivered signed; mesh.feed.get answered the stored envelope, not a pub-ack",
        };
  },
};
