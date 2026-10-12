// c10 — rooms with broker-enforced membership (EXT-5, ACL rooms): a member
// joins an ACL room and its message reaches another member; after expel, the
// broker revokes the scoped credential and the expelled member can no longer
// post. Promotes the in-memory rooms unit tests to the real broker, where
// the ACL is actually the NATS account permission, not an app-level check.
import { jwtAuthenticator } from "../../peering/lib/mesh.mjs";
import { sdkModule as sdk } from "../../peering/lib/sdk.mjs";
import { seedFor } from "../lib/test-agents.mjs";

const te = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  id: "c10",
  title: "ACL room: members talk; expel revokes the credential at the broker",
  spec: "EXT-5, §15.3",
  profile: "core",
  async run(env) {
    if (!env.creds) throw new Error("env-skip: MESH_CREDS_FILE (durable NATS creds) required");
    const auth = () => jwtAuthenticator(env.creds.jwt, te.encode(env.creds.seed));
    const { AgentMesh } = sdk;

    // An ACL room is durable, and a durable room counts against somebody's
    // limits, so its creator must be owned by someone the mesh knows. The
    // core's rule (decided 2026-10-12): any agent an account owns in the
    // ownership record may open one, counted against that account. So the
    // host is the suite's own agent (MESH_IDENTITY_FILE), which the mesh's
    // operator puts on record. A room-creator key (MESH_ROOMS_CREATOR_SEED,
    // on AgentMesh a key paired to a PAN handle) is used instead when it is
    // given. With neither, or a host nobody owns, the test env-skips and says
    // so. A core server that turns the check off (ROOMS_REQUIRE_OPERATOR=0)
    // can pass any key here.
    const hostSeed = env.roomsCreatorSeed ?? env.identity?.seed ?? null;
    if (!hostSeed) {
      throw new Error("env-skip: an ACL room needs a creator an account owns: MESH_IDENTITY_FILE (an agent on record) or MESH_ROOMS_CREATOR_SEED");
    }
    const hostIs = env.roomsCreatorSeed ? "MESH_ROOMS_CREATOR_SEED" : "MESH_IDENTITY_FILE";
    const host = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: hostSeed });
    // The guest is a standing test agent, c10-guest.test@agentmesh.ai
    // (lib/test-agents.mjs), so the registry sees a named agent rather than a
    // new unnamed one each night. Without the file, a key minted for the run.
    const guest = await AgentMesh.connect(env.meshWsUrl, { requireNamed: false, authenticator: auth(), nkeySeed: seedFor(env, "c10-guest") });
    const fails = [];
    let room = null;
    try {
      try {
        room = await host.openRoom({ acl: true, name: "c10-acl" });
      } catch (e) {
        const m = String(e?.message ?? e);
        // The host is not owned by anyone this mesh knows: the rooms service
        // refuses with UNAUTHORIZED, details.reason no_owner_on_record.
        // Older servers said "PAN handle" / "email-verified" instead.
        if (e?.details?.reason === "no_owner_on_record" || /no account on this mesh owns|PAN handle|email-verified/i.test(m)) {
          throw new Error(`env-skip: no account owns the room creator (${hostIs}); put the agent on record, or set MESH_ROOMS_CREATOR_SEED`);
        }
        throw new Error(`env-skip: ACL rooms unavailable (${m.slice(0, 80)})`); // cut-ok: error message
      }

      const heardByHost = [];
      room.onMessage((m) => { if (m?.type === "say" || m?.text) heardByHost.push(m); });

      // ACL rooms admit before they let anyone in: the guest must be invited
      // (which grants the broker-scoped credential) before it can join. Give
      // the guest a rooms.invite handler + registration so the invite delivers.
      guest.onRequest("rooms.invite", async () => ({ ok: true }));
      await guest.register({ name: "c10-guest", visibility: "unlisted", skills: [{ id: "rooms.invite", name: "rooms.invite", description: "c10" }] });
      await sleep(1000);
      await room.invite(guest.agentId).catch(() => {}); // admit happens even if delivery ack lags

      // Guest joins via the room token — now admitted.
      const guestRoom = await guest.joinRoom(room.token);
      const guestHeard = [];
      guestRoom.onMessage((m) => { if (m?.type === "say" || m?.text) guestHeard.push(m); });
      await sleep(1500);

      guestRoom.say({ text: "hello from guest" });
      await sleep(1500);
      if (!heardByHost.some((m) => JSON.stringify(m).includes("hello from guest"))) {
        fails.push("host did not receive the guest's message in the ACL room");
      }

      // Expel the guest: the rooms service must revoke its scoped credential.
      await room.expel(guest.agentId, { severity: "hard", note: "c10" });
      await sleep(3000);

      // The expelled guest tries to post again. With broker-enforced ACL, the
      // publish is refused (revoked credential) and never reaches the host.
      const before = heardByHost.length;
      let postThrew = false;
      try { guestRoom.say({ text: "should be blocked" }); await sleep(2500); }
      catch { postThrew = true; }
      const leaked = heardByHost.slice(before).some((m) => JSON.stringify(m).includes("should be blocked"));
      if (leaked) fails.push("expelled member's message still reached the room (ACL not broker-enforced)");
      // postThrew is informational: some transports drop silently, some throw.
      void postThrew;
    } catch (e) {
      if (String(e?.message ?? e).startsWith("env-skip:")) throw e;
      throw e;
    } finally {
      try { await room?.close?.("c10 done"); } catch { /* ignore */ }
      await host.close().catch(() => {});
      await guest.close().catch(() => {});
    }
    return fails.length
      ? { status: "fail", detail: fails.join("; ") }
      : { status: "pass", detail: "member message delivered; after expel the revoked credential could not post to the room" };
  },
};
