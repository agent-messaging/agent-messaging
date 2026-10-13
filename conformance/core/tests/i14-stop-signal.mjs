// i14 — a stop signal from a trusted issuer stops the agent and cuts its
// connection (SPEC §4.12, "Stop signals"). An agent enrolled with an OAuth
// token connects; the issuer pushes a CAEP `session-revoked` Security Event
// Token (RFC 8417, push per RFC 8935) naming the agent's workload identifier;
// within a minute the admin API reports the agent paused, its connection is
// closed, and a fresh proof no longer gets a credential. The test tenant,
// and the stopped agent with it, is deleted afterwards.
import { requirePart, withIssuerAndTenant, addTrust, enrollNative, connectEnrolled, adminAgent, enroll, refused, waitFor, jwt, now, randomBytes } from "../lib/identity.mjs";

const SESSION_REVOKED = "https://schemas.openid.net/secevent/caep/event-type/session-revoked";

export default {
  id: "i14",
  title: "a CAEP event stops the agent, and its connections are cut",
  spec: "§4.12, §4.13",
  profile: "identity",
  part: "stop signals",
  async run(env) {
    const caps = await requirePart(env, "stop_signals", "§4.12");
    const push = caps.stop_signals?.push;
    if (!push) throw new Error("env-skip: the mesh offers stop signals but names no push address in its capabilities");
    return withIssuerAndTenant(env, "i14", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const { agent, answer } = await enrollNative(env, issuer, "buyer-i14");
      const mesh = await connectEnrolled(env, agent, answer);
      let closed = false;
      mesh.closed?.().then(() => { closed = true; }).catch(() => { closed = true; });
      try {
        await mesh.register({ name: "buyer-i14", description: "Conformance agent.", offerings: [], visibility: "unlisted" });
        const t = now();
        const set = jwt(
          { typ: "secevent+jwt", alg: "ES256", kid: issuer.kid },
          { iss: issuer.base, aud: caps.stop_signals.audience, iat: t, jti: randomBytes(8).toString("hex"),
            events: { [SESSION_REVOKED]: { subject: { format: "opaque", id: "buyer-i14" }, event_timestamp: t } } },
          issuer.key.privateKey,
        );
        const res = await fetch(push.replace("{tenant}", encodeURIComponent(tenant)), {
          method: "POST", headers: { "content-type": "application/secevent+jwt", accept: "application/json" }, body: set, signal: AbortSignal.timeout(30_000),
        });
        if (res.status !== 202 && res.status !== 200) return { status: "fail", detail: `the push endpoint answered ${res.status} (RFC 8935 wants 202)` };
        const fails = [];
        const stopped = await waitFor(async () => (await adminAgent(env, agent.id))?.standing?.stopped, 60_000, 2000);
        if (!stopped) fails.push("the admin API did not report the agent stopped within 60 s");
        else if (stopped.action !== "pause") fails.push(`the stop's action is ${JSON.stringify(stopped.action)}, not pause`);
        if (mesh.closed && !(await waitFor(() => closed, 30_000))) fails.push("the agent's connection was still open 30 s after the stop");
        const again = await enroll(env, { agent_id: agent.id, proof: { kind: "oauth", token: issuer.token(env, "buyer-i14") } });
        if (!refused(again)) fails.push("a fresh proof got a credential for the stopped agent");
        return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: "paused, cut, and refused a new credential" };
      } finally {
        await mesh.close().catch(() => {});
      }
    });
  },
};
