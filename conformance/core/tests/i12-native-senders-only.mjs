// i12 — "native senders only" (EXT-6 0.5.0 §4: the `bridged` tier). A
// receiver whose admission roster says `defaults.bridged: "block"` and
// `defaults.registered: "allow"` refuses a message a bridge sends for an OAuth
// caller, and admits one from a native agent enrolled through the same
// issuer. The difference is where the identity came from, not who the issuer
// is.
import { requirePart, withIssuerAndTenant, addTrust, enrollNative, connectEnrolled, mcpTool, waitFor } from "../lib/identity.mjs";

export default {
  id: "i12",
  title: "a bridged: block roster refuses a bridged sender and admits a native one",
  spec: "EXT-6 §4, §4.15",
  profile: "identity",
  part: "admission by source",
  async run(env) {
    const caps = await requirePart(env, "admission_by_source", "EXT-6 §4");
    if (!caps.bridge?.mcp) throw new Error("env-skip: the mesh offers admission by source but no MCP bridge front to send a bridged message from (§4.15)");
    return withIssuerAndTenant(env, "i12", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const rx = await enrollNative(env, issuer, "receiver-i12");
      const tx = await enrollNative(env, issuer, "sender-i12");
      const receiver = await connectEnrolled(env, rx.agent, rx.answer);
      const sender = await connectEnrolled(env, tx.agent, tx.answer);
      const got = [];
      try {
        receiver.onRequest("chat", (input, ctx) => { got.push(ctx.envelope); return { text: "ok" }; });
        await receiver.register({ name: "receiver-i12", description: "Conformance receiver.", offerings: [{ id: "chat", name: "Chat", description: "Talk." }], visibility: "unlisted" });
        await receiver.admission.start({ registered: "allow", bridged: "block" });
        await sender.register({ name: "sender-i12", description: "Conformance sender.", offerings: [], visibility: "unlisted" });
        const token = issuer.token(env, "caller-i12", { aud: caps.bridge.mcp });
        await mcpTool(caps.bridge.mcp, token, "send", { to: rx.agent.id, text: "bridged, should be blocked" });
        await sender.request(rx.agent.id, "chat", { text: "native, should arrive" }).catch(() => null);
        await waitFor(() => got.some((e) => e.from === tx.agent.id), 15_000);
        await new Promise((ok) => setTimeout(ok, 3000));
        const fails = [];
        if (!got.some((e) => e.from === tx.agent.id)) fails.push("the native sender's message did not arrive");
        if (got.some((e) => e.meta?.identity_bridge)) fails.push("the bridged sender's message arrived through a bridged: block roster");
        return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: "bridged refused, native admitted" };
      } finally {
        await receiver.close().catch(() => {});
        await sender.close().catch(() => {});
      }
    });
  },
};
