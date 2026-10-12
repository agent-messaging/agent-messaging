# Agent Messaging

A protocol for agents that work over reliable messaging. Agents send each other
signed messages that wait in an inbox while the receiver is offline, publish
events that every matching subscriber receives, and register in a registry
beside a presence service that says who is online right now.

The Agent Messaging Server is the reference implementation, and it implements
the core profile. AgentMesh, the sponsor, runs a network that claims the full
specification. Envelope fields, version strings, `mesh.*` subjects, package
names and SDK APIs carry the names they have always had.

This repository holds the specification and the conformance suite that tests
whether an implementation follows it. The reference platform, the SDKs, and the
tools for running a network live elsewhere. The specification is also published
at <https://agentmessaging.ai>.

## What's here

- **[SPEC.md](SPEC.md)**: Agent Messaging 0.7. It presents the protocol by the
  three ways agents talk: inbox messaging (`request`, `respond`), publish and
  subscribe (`emit`, `subscribe`, feeds), and registry and presence. It also
  covers identity and signing, the envelope, tasks, streaming, errors, the
  subject namespace, tenancy, limits, extensions, the two conformance profiles
  (§1.6), and bindings: what any messaging system must provide (§18.1) and the
  reference binding on NATS JetStream. Readable at
  <https://agentmessaging.ai/spec.html>.
- **[SPEC-NAMING.md](SPEC-NAMING.md)**: Agent Naming, the naming layer. It says
  how a handle resolves to a card over ordinary HTTPS, why a domain outranks
  every registrar, how trust attestations stay portable, and how a handle moves
  to a new registrar. Readable at <https://agentnaming.ai/spec.html>.
- **[conformance/](conformance/)**: black-box tests run against a live server,
  and byte-level fixtures. Every test belongs to a profile: 30 core tests that
  every server must pass, 5 tests of the deployment-defined parts AgentMesh
  offers, and 5 tests of Agent Naming registrars. Each test cites the sections it
  checks. A red test is a defect in the code or in the specification, and which
  of the two it is gets decided explicitly, in writing. Nobody edits a test just
  to make it pass.

## Running the conformance suite

The tests exercise a running server over its real wire, on the reference binding.
A run of the core profile has no default address, so name the server you want to
test:

```
cd conformance/peering && npm install
cd ..
MESH_WS_URL=wss://mesh.example.com MESH_CREDS_FILE=~/mesh.creds   STOREFRONT_BASE=https://api.example.com node run.mjs
```

`run.mjs` runs the core tests of both suites and prints the specification
version and profile it tested. `--profile platform`, `--profile naming` and
`--profile all` run the others, `--only <id>` runs one test, `--ci` fails on a
regression against `expectations.json`, and `--update` records a new baseline.
A test whose prerequisite is missing reports **env-skip** and names it, so a
missing prerequisite never shows up as a pass. [conformance/README.md](conformance/README.md)
lists every setting. The adapter tests (c12, c13, c15) also need the reference
adapter, which lives with the AgentMesh SDKs.

## Licensing

The specification prose (SPEC.md, SPEC-NAMING.md) is licensed under
[CC BY 4.0](LICENSE-SPEC), so you can implement it freely, with attribution. All
code, including the conformance suite, is licensed under [Apache-2.0](LICENSE).

## Reporting a security issue

A break in one of the guarantees the specification makes (an envelope accepted
without a valid signature, one party able to act as another, a name taken from
its owner) is a vulnerability, and should not be filed as an ordinary issue.
Report it privately, through GitHub private vulnerability reporting:

<https://github.com/jeffrschneider/agent-messaging/security/advisories/new>

That thread is visible only to you and the maintainers until an advisory is
published. Please do not open a public issue for it. Reports are read by a very
small number of people, so expect a reply in days rather than hours.

## Related

- The specification site: <https://agentmessaging.ai>
- Agent Naming: <https://agentnaming.ai>
- AgentMesh, the sponsor: <https://agentmesh.ai>
- Run your own mesh: <https://github.com/jeffrschneider/agentmesh-deploy>
- Developer docs: <https://dev.agentmesh.ai>
