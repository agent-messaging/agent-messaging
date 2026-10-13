// Shared by the `identity` profile's tests (i01 to i14): bring your own
// identity, SPEC §4.13 to §4.16, §4.12's stop signals, §9.7's
// identity_source and EXT-6 0.5.0's admission by source
// (docs/bring-your-own-identity-plan.md, steps 8 and 10 to 16).
//
// Every part these tests cover is deployment-defined (SPEC §1.6), so each test
// first asks the mesh whether it offers the part, and is an env-skip when it
// does not. A mesh says what it offers in its capabilities answer
// (GET <mesh home>/v1/capabilities), in an `identity` member:
//
//   "identity": {
//     "enroll": ["oauth", "jwt-svid", "x509-svid"],    the proofs §4.14 accepts
//     "bridge": { "https": "<url>", "mcp": "<url>" },   the fronts of §4.15
//     "admission_by_source": true,                      EXT-6 §4 and §4.1
//     "stop_signals": { "push": "<url, {tenant}>",      §4.12, RFC 8935 push
//                       "audience": "<receiver id>" }
//   }
//
// The tests stand up their own OAuth issuer and SPIFFE bundle (LocalIssuer):
// an HTTP server on this machine serving OpenID metadata, a key set and a
// SPIFFE bundle, signing with ES256. The server under test must be able to
// reach it: IDENTITY_ISSUER_LISTEN sets where it listens (default
// 127.0.0.1:0) and IDENTITY_ISSUER_BASE the address the server should use
// (default http://<listen address>). A server that accepts only https://
// issuers needs IDENTITY_ISSUER_BASE to name an https:// front for it, or a
// test setting that lets it fetch from a plain http:// test issuer.
//
// The tests write trust records through the admin API (MESH_ADMIN_TOKEN_FILE,
// MESH_ADMIN_URL): POST /admin/v1/tenants/:tenant/trust adds one, and each
// test makes a fresh tenant and deletes it afterwards.
import http from "node:http";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, createHmac } from "node:crypto";
import { nkeys } from "../../peering/lib/mesh.mjs";

const te = new TextEncoder();
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const json64 = (o) => b64u(JSON.stringify(o));
const now = () => Math.floor(Date.now() / 1000);

async function call(method, url, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": raw ? "application/secevent+jwt" : "application/json", ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch((e) => ({ failed: String(e?.message ?? e) }));
  if (res.failed) return { status: 0, text: res.failed, json: null };
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}

/** The mesh's `identity` capabilities, or null when it says nothing. */
export async function identityCaps(env) {
  if (!env.storefrontBase) throw new Error("env-skip: STOREFRONT_BASE (the mesh's HTTPS API) required for the identity profile");
  const r = await call("GET", `${env.storefrontBase}/v1/capabilities`);
  if (r.status !== 200 || !r.json) throw new Error(`env-skip: the mesh's capabilities answer could not be read (${r.status})`);
  return r.json.identity ?? null;
}

/** Throw env-skip unless the mesh offers `what`; returns the capabilities. */
export async function requirePart(env, what, section) {
  const caps = await identityCaps(env);
  const offered =
    what.startsWith("enroll:") ? caps?.enroll?.includes(what.slice(7))
      : what.startsWith("bridge:") ? !!caps?.bridge?.[what.slice(7)]
        : !!caps?.[what];
  if (!offered) throw new Error(`env-skip: the mesh under test does not offer ${what} (${section}); a part it does not offer is not tested`);
  if (!env.admin?.token && !what.startsWith("on_behalf_of")) {
    throw new Error("env-skip: MESH_ADMIN_TOKEN_FILE (the admin API, to write trust records) required for the identity profile");
  }
  return caps;
}

/** A fresh tenant for one test, and a function that removes it. */
export async function freshTenant(env, tag) {
  const id = `idc-${tag}-${randomBytes(4).toString("hex")}`;
  const h = { authorization: `Bearer ${env.admin.token}` };
  const r = await call("POST", `${env.admin.url}/admin/v1/tenants`, { body: { id }, headers: h });
  if (r.status !== 200 && r.status !== 201) throw new Error(`could not make a test tenant (${r.status} ${r.text.slice(0, 200)})`); // cut-ok: an error message
  // Trust records go first. A server refuses to delete a tenant that still holds
  // agents, and an issuer belongs to one account per mesh (§4.14), so a record
  // left behind would block the next test that trusts the same issuer.
  const remove = async () => {
    const list = await call("GET", `${env.admin.url}/admin/v1/tenants/${id}/trust`, { headers: h });
    for (const t of list.json?.trust ?? []) {
      if (t?.id) await call("DELETE", `${env.admin.url}/admin/v1/tenants/${id}/trust/${encodeURIComponent(t.id)}`, { headers: h });
    }
    await call("DELETE", `${env.admin.url}/admin/v1/tenants/${id}`, { headers: h });
  };
  return { id, remove: () => remove().catch(() => null) };
}

/** Add a trust record (SPEC §4.14) to a tenant through the admin API. */
export async function addTrust(env, tenant, record) {
  const r = await call("POST", `${env.admin.url}/admin/v1/tenants/${tenant}/trust`, { body: record, headers: { authorization: `Bearer ${env.admin.token}` } });
  if (r.status !== 200 && r.status !== 201) throw new Error(`the admin API refused the trust record (${r.status} ${r.text.slice(0, 200)})`); // cut-ok: an error message
  return r.json;
}

/** The admin API's view of one agent: its account and its standing. */
export async function adminAgent(env, key) {
  const r = await call("GET", `${env.admin.url}/admin/v1/agents/${key}`, { headers: { authorization: `Bearer ${env.admin.token}` } });
  return r.status === 200 ? r.json : null;
}

/** A fresh agent key pair, made here as an agent makes its own (§4.3). */
export function newAgent() {
  const kp = nkeys.createUser();
  return { kp, id: kp.getPublicKey(), seed: new TextDecoder().decode(kp.getSeed()) };
}

/** POST to the enrollment door (§4.14): the door that redeems a one-time key. */
export function enroll(env, body, headers = {}) {
  return call("POST", `${env.storefrontBase}/v1/bootstrap`, { body, headers });
}

/** The enrollment door's address, as a DPoP proof's `htu` names it. */
export const enrollUrl = (env) => `${env.storefrontBase}/v1/bootstrap`;

/** POST to the node-credential door (§4.8), the ordinary renewal path, signed
 *  with the node key the enrollment answer bound the credential to and the
 *  agent's own key, exactly as the adapter signs a renewal. */
export function ordinaryRenewal(env, nodeSeed, agentKp) {
  const node = nkeys.fromSeed(te.encode(nodeSeed));
  const nodeId = node.getPublicKey();
  const agentId = agentKp.getPublicKey();
  const ts = now();
  const s = (kp, str) => Buffer.from(kp.sign(te.encode(str))).toString("base64");
  return call("POST", `${env.storefrontBase}/v1/node-credential`, {
    body: {
      node_id: nodeId, ts,
      node_sig: s(node, `mesh-node-cred-v1:${ts}:${nodeId}:${agentId}`),
      agents: [{ id: agentId, sig: s(agentKp, `mesh-node-agent-v1:${ts}:${nodeId}:${agentId}`) }],
    },
  });
}

/** A refusal is any answer that issued nothing. Its reason, when the door
 *  gave one (§4.14: UNAUTHORIZED with details.reason). */
export function refused(r) {
  return !(r.status >= 200 && r.status < 300 && r.json?.jwt);
}
export function reasonOf(r) {
  return r.json?.details?.reason ?? r.json?.error?.details?.reason ?? r.json?.reason ?? null;
}

/** An EC P-256 key: its private key object, its public JWK and thumbprint. */
export function ecKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const thumb = b64u(createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
  return { privateKey, jwk, thumb };
}

/** Sign a JWT with ES256 (or the forms a door must refuse: `none`, HS256). */
export function jwt(header, claims, key) {
  const head = json64(header);
  const body = json64(claims);
  const input = `${head}.${body}`;
  if (header.alg === "none") return `${input}.`;
  if (header.alg === "HS256") return `${input}.${b64u(createHmac("sha256", key).update(input).digest())}`;
  return `${input}.${b64u(cryptoSign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }))}`;
}

/** A DPoP proof (RFC 9449) for one request. */
export function dpopProof(k, { htm = "POST", htu, accessToken, jti = randomBytes(12).toString("base64url"), iat = now() }) {
  const claims = { htm, htu, iat, jti };
  if (accessToken) claims.ath = b64u(createHash("sha256").update(accessToken).digest());
  return jwt({ typ: "dpop+jwt", alg: "ES256", jwk: k.jwk }, claims, k.privateKey);
}

/** An OAuth issuer and a SPIFFE trust bundle, served from this machine. */
export class LocalIssuer {
  constructor() {
    this.key = ecKey();
    this.kid = `i-${randomBytes(4).toString("hex")}`;
    this.svidKey = ecKey();
    this.svidKid = `s-${randomBytes(4).toString("hex")}`;
  }
  async start() {
    const listen = process.env.IDENTITY_ISSUER_LISTEN ?? "127.0.0.1:0";
    const [host, port] = [listen.slice(0, listen.lastIndexOf(":")), Number(listen.slice(listen.lastIndexOf(":") + 1))];
    this.server = http.createServer((req, res) => {
      const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url === "/.well-known/openid-configuration" || req.url === "/.well-known/oauth-authorization-server") {
        return send({ issuer: this.base, jwks_uri: `${this.base}/jwks.json`, token_endpoint: `${this.base}/token` });
      }
      if (req.url === "/jwks.json") return send({ keys: [{ ...this.key.jwk, kid: this.kid, alg: "ES256", use: "sig" }] });
      if (req.url === "/bundle") return send({ keys: [{ ...this.svidKey.jwk, kid: this.svidKid, use: "jwt-svid" }], spiffe_refresh_hint: 60 });
      res.writeHead(404); res.end();
    });
    await new Promise((ok) => this.server.listen(port, host, ok));
    const addr = this.server.address();
    this.base = (process.env.IDENTITY_ISSUER_BASE ?? `http://${host}:${addr.port}`).replace(/\/$/, "");
    return this;
  }
  close() { this.server?.close(); }
  /** An RFC 9068 access token for `workload`, with any claims overridden. */
  token(env, workload, over = {}, header = {}) {
    const t = now();
    const claims = { iss: this.base, aud: env.storefrontBase, sub: workload, client_id: workload, iat: t, exp: t + 300, jti: randomBytes(8).toString("hex"), ...over };
    for (const [k, v] of Object.entries(claims)) if (v === undefined) delete claims[k];
    return jwt({ typ: "at+jwt", alg: "ES256", kid: this.kid, ...header }, claims, this.key.privateKey);
  }
  /** A JWT-SVID for `spiffeId`. */
  svid(env, spiffeId, over = {}) {
    const t = now();
    return jwt({ typ: "JWT", alg: "ES256", kid: this.svidKid }, { sub: spiffeId, aud: [env.storefrontBase], iat: t, exp: t + 300, ...over }, this.svidKey.privateKey);
  }
  oauthRecord(env, over = {}) {
    return { kind: "oauth", issuer: this.base, audience: env.storefrontBase, require_binding: false, ...over };
  }
  spiffeRecord(trustDomain, over = {}) {
    return { kind: "spiffe", trust_domain: trustDomain, bundle_endpoint: `${this.base}/bundle`, require_mtls: false, ...over };
  }
}

/** Run `body` with a local issuer and a fresh tenant, cleaning both up. */
export async function withIssuerAndTenant(env, tag, body) {
  const issuer = await new LocalIssuer().start();
  let tenant = null;
  try {
    tenant = await freshTenant(env, tag);
    return await body(issuer, tenant.id);
  } finally {
    issuer.close();
    await tenant?.remove();
  }
}

/** The `identity` capabilities' MCP front, as a JSON-RPC client over
 *  streamable HTTP (MCP 2025-06-18), with the credential in the request. */
export async function mcpCall(url, token, method, params, id = 1, session = null) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  if (session) headers["mcp-session-id"] = session;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const line = text.trim().startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "");
  let body = null;
  try { body = JSON.parse(line); } catch { /* no body */ }
  return { status: res.status, body, session: res.headers.get("mcp-session-id") ?? session };
}

/** Open an MCP session and call one tool. */
export async function mcpTool(url, token, name, args) {
  const init = await mcpCall(url, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-messaging-conformance", version: "1" } });
  if (init.status !== 200) return { status: init.status, body: init.body };
  return mcpCall(url, token, "tools/call", { name, arguments: args }, 2, init.session);
}

/** Enroll a fresh agent natively with an OAuth token for `workload`; the
 *  tenant must already trust the issuer. Returns the agent and the answer. */
export async function enrollNative(env, issuer, workload) {
  const agent = newAgent();
  const r = await enroll(env, { agent_id: agent.id, proof: { kind: "oauth", token: issuer.token(env, workload) } });
  // cut-ok: an error message
  if (refused(r)) throw new Error(`enrolling ${workload} natively failed (${r.status} ${r.text.slice(0, 160)})`);
  return { agent, answer: r.json };
}

/** Connect an enrolled agent with the SDK under test, as the "Run it" guide
 *  does: the transport from the mesh object, the credential from the answer. */
export async function connectEnrolled(env, agent, answer) {
  const { sdkModule: sdk } = await import("../../peering/lib/sdk.mjs");
  const { servers } = sdk.transportFromMesh(answer.mesh);
  return sdk.AgentMesh.connect(servers, {
    nkeySeed: agent.seed,
    authenticator: sdk.jwtAuthenticator(answer.jwt, te.encode(answer.seed)),
    jwt: answer.jwt,
    platformApi: env.storefrontBase,
  });
}

/** Wait up to `ms` for `check()` to return something truthy. */
export async function waitFor(check, ms, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v || Date.now() > end) return v;
    await new Promise((ok) => setTimeout(ok, every));
  }
}

/** Where an agent's identity_source sits in a discovery result or a describe
 *  document (SPEC §9.3, §9.7, §10.14). */
export const sourceOf = (o) => o?.identity_source ?? o?.node_profile?.identity_source ?? o?.manifest?.identity_source ?? null;

export { now, randomBytes };
