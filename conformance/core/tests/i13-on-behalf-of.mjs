// i13 — evidence of acting for a person is verified, refused or unverifiable,
// never taken on trust (SPEC §4.16). The SDK under test checks
// `meta.on_behalf_of` against an issuer the receiver trusts, given here with
// its key set so nothing is fetched (§4.13 rule 4):
//
//   - a token for the receiver, from the trusted issuer: verified;
//   - a token for another audience: refused, never verified;
//   - a token from an issuer the receiver does not trust: unverifiable.
//
// This is a test of the SDK and needs no mesh. It is an env-skip for an SDK
// with no `verifyOnBehalfOf`.
import { LocalIssuer, now } from "../lib/identity.mjs";

const resultOf = (r) => (typeof r === "string" ? r : r?.result ?? r?.status ?? null);

export default {
  id: "i13",
  title: "on_behalf_of for another audience is never reported as verified",
  spec: "§4.16",
  profile: "identity",
  part: "acting for a person",
  async run() {
    const { sdkModule: sdk } = await import("../../peering/lib/sdk.mjs");
    if (typeof sdk.verifyOnBehalfOf !== "function") throw new Error("env-skip: the SDK under test has no verifyOnBehalfOf (§4.16)");
    const trusted = new LocalIssuer();
    const stranger = new LocalIssuer();
    trusted.base = "https://idp.conformance.example";
    stranger.base = "https://other-idp.conformance.example";
    const receiver = "UCONFORMANCERECEIVERI13AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const t = now();
    const make = (issuer, aud) => issuer.token({ storefrontBase: aud }, "person-i13", { sub: "person-i13", client_id: "agent-i13", aud, iat: t, exp: t + 300 });
    const envelopeWith = (issuer, token) => ({ meta: { on_behalf_of: { kind: "token-exchange", token, issuer: issuer.base } } });
    const opts = { audience: receiver, trustedIssuers: [{ issuer: trusted.base, jwks: { keys: [{ ...trusted.key.jwk, kid: trusted.kid, alg: "ES256" }] } }] };
    const fails = [];
    const good = resultOf(await sdk.verifyOnBehalfOf(envelopeWith(trusted, make(trusted, receiver)), opts));
    if (good !== "verified") fails.push(`a token for the receiver from the trusted issuer was ${JSON.stringify(good)}, not verified`);
    const wrongAud = resultOf(await sdk.verifyOnBehalfOf(envelopeWith(trusted, make(trusted, "https://someone-else.example")), opts));
    if (wrongAud !== "refused") fails.push(`a token for another audience was ${JSON.stringify(wrongAud)}, not refused`);
    const unknown = resultOf(await sdk.verifyOnBehalfOf(envelopeWith(stranger, make(stranger, receiver)), opts));
    if (unknown !== "unverifiable") fails.push(`a token from an untrusted issuer was ${JSON.stringify(unknown)}, not unverifiable`);
    return fails.length ? { status: "fail", detail: fails.join("; ") } : { status: "pass", detail: "verified, refused and unverifiable as §4.16 says" };
  },
};
