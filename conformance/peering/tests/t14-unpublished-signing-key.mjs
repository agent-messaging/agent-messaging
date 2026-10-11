// SPEC-NAMING §5.3: the card-signing key MUST come from the authority's own
// out-of-band endpoint, not from the document being verified.
//
// WHY THIS TEST EXISTS. t06a proves an UNSIGNED card dies. It does not prove
// anything about a card that is signed — and a signature verified against a key
// carried in the same response proves only that the response is internally
// consistent. Anyone can mint a keypair, sign a card for a handle they do not
// hold, and put their own public key beside it. That forgery passed the
// reference resolver: `verifyAndPinCard` read `registrar_key` straight out of
// the resolve document and never asked the origin what it actually publishes.
//
// The pin was not a defence. It fires only for an origin already seen, and only
// as a console warning — and the case that matters most is FIRST contact with a
// registrar reached by following a §5.6 referral, where there is no pin at all.
// That is the shape of the attack: refer a resolver to a hostile origin, hand it
// a signed card binding somebody else's handle to your agent id.
//
// Verified red against the pre-fix adapter (case (a) resolved ✓, returning the
// attacker's agent id for the victim's handle) before the check was added.
import { serve, runResolver } from "../lib/resolver.mjs";
import { nkeys, canonicalJSON } from "agentmesh";

const HANDLE = "Victim.someone@example.com";

// The attacker's key: minted here, never published by the origin below.
const attacker = nkeys.createUser();
const attackerId = nkeys.createUser().getPublicKey();
const decoy = nkeys.createUser().getPublicKey();

const CARD = {
  handle: HANDLE,
  operator: { name: "Someone Else" },
  binding: "agent-key",
  endpoints: [{ protocol: "agentmesh", agent_id: attackerId }],
};
const SIG = Buffer.from(
  attacker.sign(new TextEncoder().encode(canonicalJSON(CARD))),
).toString("base64");

/** An origin that always serves the forged (but self-consistent) card, and
 *  publishes whatever key set the case calls for. */
const hostileOrigin = (keys) =>
  serve((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/api/registrar-key")) {
      return res.end(JSON.stringify({
        ok: true,
        keys,
        key_set: keys.map((k) => ({ key: k, kid: "t14", status: "current", use: "pan-card-signing" })),
      }));
    }
    res.end(JSON.stringify({ ok: true, card: CARD, registrar_key: attacker.getPublicKey(), registrar_sig: SIG }));
  });

const resolved = (out) => /✓ Victim/i.test(out);

export default {
  id: "t14",
  title: "a signed card whose key the authority does not publish is discarded",
  spec: "SPEC-NAMING §5.3",
  async run() {
    const problems = [];

    // (a) THE FORGERY. Signature verifies against the key in the document; the
    // origin publishes a different key. Must be refused.
    const unpublished = await hostileOrigin([decoy]);
    try {
      const out = await runResolver(["diag", "resolve", HANDLE], {
        PAN_REGISTRAR: `http://127.0.0.1:${unpublished.address().port}`,
      });
      if (resolved(out)) {
        problems.push(
          `a card signed with an UNPUBLISHED key was accepted — §5.3 REGRESSION. ` +
          `The resolver returned the signer's own agent id for ${HANDLE} (said: ${out.trim().split("\n").pop()})`,
        );
      }
    } finally {
      unpublished.close();
    }

    // (b) THE CONTROL. Byte-identical card, and now the origin publishes the
    // signing key. This MUST resolve — without it, (a) passing would prove
    // nothing more than that the resolver refuses everything.
    const published = await hostileOrigin([attacker.getPublicKey()]);
    try {
      const out = await runResolver(["diag", "resolve", HANDLE], {
        PAN_REGISTRAR: `http://127.0.0.1:${published.address().port}`,
      });
      if (!resolved(out)) {
        problems.push(
          `a card signed with a key the origin DOES publish was refused — the §5.3 check is ` +
          `rejecting valid resolutions, not just forged ones (said: ${out.trim().split("\n").pop()})`,
        );
      }
    } finally {
      published.close();
    }

    // (c) NO KEY SET AT ALL. An origin that publishes nothing cannot be
    // verified against, and "cannot verify" must mean refuse — not "any key
    // will do", which is what a fall-back-to-the-document would amount to.
    const silent = await serve((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/api/registrar-key")) {
        res.statusCode = 404;
        return res.end("{}");
      }
      res.end(JSON.stringify({ ok: true, card: CARD, registrar_key: attacker.getPublicKey(), registrar_sig: SIG }));
    });
    try {
      const out = await runResolver(["diag", "resolve", HANDLE], {
        PAN_REGISTRAR: `http://127.0.0.1:${silent.address().port}`,
      });
      if (resolved(out)) {
        problems.push(
          `an origin publishing NO signing key still had its card accepted — an unverifiable ` +
          `authority must be refused (said: ${out.trim().split("\n").pop()})`,
        );
      }
    } finally {
      silent.close();
    }

    return problems.length
      ? { status: "fail", detail: problems.join("\n") }
      : {
          status: "pass",
          detail: "forged card with an unpublished key refused; the same card with a published key resolves; an origin publishing no key set is refused",
        };
  },
};
