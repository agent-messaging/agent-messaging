// i11 — a bridged message says it is bridged and never passes as native
// (SPEC §4.15, rules 2 and 4). A caller with no mesh key calls the bridge's
// MCP front with an OAuth token from a trusted issuer and sends a message to
// a native agent. The receiver sees the `identity_bridge` marker in the
// envelope's `meta` (caller_kind `oauth`, front `mcp`, the bridge's node key,
// no account), and the sender's identity_source is kind `bridged`. The token
// travels in the Authorization header and never as a tool argument (rule 6).
import { requirePart, withIssuerAndTenant, addTrust, enrollNative, connectEnrolled, mcpTool, waitFor, sourceOf } from "../lib/identity.mjs";

export default {
  id: "i11",
  title: "a bridged message carries the marker and never verifies as native",
  spec: "§4.15",
  profile: "identity",
  part: "identity bridges (mcp)",
  async run(env) {
    const caps = await requirePart(env, "bridge:mcp", "§4.15");
    return withIssuerAndTenant(env, "i11", async (issuer, tenant) => {
      await addTrust(env, tenant, issuer.oauthRecord(env));
      const { agent, answer } = await enrollNative(env, issuer, "receiver-i11");
      const mesh = await connectEnrolled(env, agent, answer);
      let seen = null;
      try {
        mesh.onRequest("chat", (input, ctx) => { seen = ctx.envelope; return { text: "got it" }; });
        await mesh.register({ name: "receiver-i11", description: "Conformance receiver.", offerings: [{ id: "chat", name: "Chat", description: "Talk." }], visibility: "unlisted" });
        const token = issuer.token(env, "caller-i11", { aud: caps.bridge.mcp });
        const sent = await mcpTool(caps.bridge.mcp, token, "send", { to: agent.id, text: "hello from i11" });
        if (sent.status !== 200 || sent.body?.error || sent.body?.result?.isError) {
          return { status: "fail", detail: `the bridge's send failed (${sent.status} ${JSON.stringify(sent.body?.error ?? sent.body?.result ?? null)})` };
        }
        await waitFor(() => seen, 15_000);
        if (!seen) return { status: "fail", detail: "the bridged message did not arrive within 15 s" };
        const fails = [];
        const m = seen.meta?.identity_bridge;
        if (!m) fails.push("the envelope carries no meta.identity_bridge");
        else {
          if (m.caller_kind !== "oauth") fails.push(`caller_kind is ${JSON.stringify(m.caller_kind)}`);
          if (m.front !== "mcp") fails.push(`front is ${JSON.stringify(m.front)}`);
          if (typeof m.bridge !== "string" || !m.bridge) fails.push("the marker names no bridge");
          if (typeof m.caller_ref !== "string" || !m.caller_ref) fails.push("the marker has no caller_ref");
          if ("account" in m || "tenant" in m) fails.push("the marker carries the caller's account");
        }
        if (JSON.stringify(seen).includes(token)) fails.push("the caller's token reached the envelope");
        const src = sourceOf(await mesh.describe(seen.from).catch(() => null));
        if (src?.kind !== "bridged") fails.push(`the sender's identity_source is ${JSON.stringify(src)}, not bridged`);
        return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: `marked bridged by ${m.bridge.slice(0, 8)}…, caller_kind oauth, front mcp` }; // cut-ok: a key prefix for the board
      } finally {
        await mesh.close().catch(() => {});
      }
    });
  },
};
