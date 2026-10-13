# Agent Messaging conformance

Executable tests for Agent Messaging (`../SPEC.md`, https://agentmessaging.ai). There are two suites:

- `core/` tests a live mesh: events, tasks, signing, admission, mailboxes, rooms, feeds, credentials and revocation.
- `peering/` tests the peered-mesh preconditions, the naming client and the registrars (`peering/README.md`).

The JSON files in this folder are test vectors that the SDK unit tests read. They are not live tests.

## Profiles

SPEC.md §1.6 defines two conformance profiles, and the suite groups its tests in four. Every test says which group it belongs to, in its `profile` field:

- **core**: what every Agent Messaging server must pass. A mesh that runs only the core, such as the Agent Messaging Server, runs these as its health check.
- **platform**: a part that §1.6 makes deployment-defined and that AgentMesh offers. A core server may leave these out.
- **naming**: a test of Agent Naming registrars, not of a messaging server. These belong to Agent Naming's own suite and run here until they move there.
- **identity**: bring your own identity (SPEC.md §4.12 stop signals, §4.13 to §4.16, §9.7, EXT-6 0.5.0). Every part is deployment-defined and any server may offer it, so each test names its `part` and is an env-skip on a mesh whose capabilities answer does not offer that part. `core/lib/identity.mjs` says what the tests need: the admin API, and a test OAuth issuer and SPIFFE bundle the server can reach.

| Profile | Tests |
|---|---|
| core (32) | c01, c01b, c02 to c07, c09 to c16, c18 to c20, c22, c23, c24, c24b; t01 to t05, t06a, t06b, t09, t14 |
| platform (5) | c08 (AgentMesh's own retired guest routes), c21 (§4.11 places, which need a signed-in person), c22b (provider advisories), t05b (the HTTPS describe door), t10 (federation) |
| naming (5) | t07, t08, t11, t12, t13 |
| identity (14) | i01 to i09 (native enrollment by an outside proof), i10 (`identity_source`), i11 (identity bridges), i12 (admission by source), i13 (`on_behalf_of`, a test of the SDK), i14 (stop signals) |

`tools/ci/check-baseline-completeness.mjs` fails on a test with no profile, so a new test cannot be left out of the core set by accident.

## Running the core profile

```
cd conformance/peering && npm install
cd ../../mesh-adapter && npm ci
cd ../conformance
MESH_WS_URL=wss://mesh.example.com MESH_CREDS_FILE=~/mesh.creds STOREFRONT_BASE=https://api.example.com \
  node run.mjs
```

`run.mjs` runs the core tests of both suites on one board and prints the specification version and profile it tested. It
takes no default address: without `MESH_WS_URL` it stops. The other settings are optional, and a test that needs one that
is missing says so as an env-skip.

| Variable | What it is | Tests that need it |
|---|---|---|
| `MESH_WS_URL` | the mesh's NATS WebSocket address | all live tests |
| `MESH_CREDS_FILE` | a NATS credentials file for the suite (default `~/.agentmesh/mesh.creds`) | all live tests |
| `STOREFRONT_BASE` | the mesh's HTTPS API, where the credential doors and the key check are | c19, c20, c22, c24, c24b |
| `MESH_IDENTITY_FILE` | an agent identity the suite signs as and mints credentials for (default `~/.agentmesh/adapter/identity.json`). An account on the mesh must hold it: c10 opens its room as this agent, and the node-credential door issues nothing for a key no account holds (on AgentMesh it is named and held as `suite.test@agentmesh.ai` with the standing agents; on a server of your own, enroll it with `mesh-admin agents enroll`) | c10, c20, c24, c24b, t02, t05 |
| `MESH_ADMIN_TOKEN_FILE`, `MESH_ADMIN_URL` | the mesh's admin token file and admin API (default `http://127.0.0.1:3005`), for a mesh you run. On a mesh that offers no naming (its capabilities answer says `naming: false`), the adapter answers only as an agent an account holds, so the adapter tests enroll the adapter's fresh key with this, in the tenant `conformance`, and remove it afterwards | c12, c13, c15 on a mesh with no naming |
| `MESH_ROOMS_CREATOR_SEED` | optional: a different key for c10 to open its room with, such as a key paired to an Agent Naming name. Used instead of `MESH_IDENTITY_FILE` when set | c10 |
| `MESH_CONFORMANCE_AGENTS_FILE` | standing keys for the agents the suite registers, needed where registration requires a name (on a mesh that offers naming, the adapter tests need them too, since the adapter answers only as a named agent there) | c03 to c20 |
| `REGISTRAR` | an Agent Naming registrar for the adapter tests; unset, the adapter uses its own default | c12, c13, c15 |
| `ECHO_TARGET` | an agent for t02 and t05 to send to; unset, the suite starts its own with the reference adapter | t02, t05 |

## Bindings

The suite runs against a mesh on either binding (SPEC.md §18): NATS JetStream, the reference binding, or RabbitMQ
(`docs/agent-messaging-rabbitmq-binding.md`). `MESH_WS_URL`'s scheme says which: `ws://`, `wss://` or `nats://` for
NATS, `amqp://` or `amqps://` for RabbitMQ. On RabbitMQ the suite reaches the mesh through the SDK's AMQP
transport, so `AGENTMESH_SDK` must name a build that has it, and the adapter tests need an adapter whose SDK has it.
The board says which binding it tested.

A test that checks something only one binding has says so in a `binding` field (`nats` or `amqp`) and is reported
`binding-skip`, not evaluated, on the other. Where a test checks one property in each binding's own terms (c01b's
durable consumer, c11's mailbox), it says which in its detail. Each binding keeps its own record of agreed results:
`expectations.json` for NATS and `expectations.amqp.json` for RabbitMQ.

## Other runs

```
node run.mjs --profile platform   # AgentMesh's deployment-defined parts
node run.mjs --profile naming     # the registrar tests (peering/rig/two-registrars.sh)
node run.mjs --profile identity   # bring your own identity, the parts the mesh offers
node run.mjs --profile all        # everything
node run.mjs --only c05           # one test
node run.mjs --ci                 # exit 1 on a regression against expectations.json
node run.mjs --update             # record this run's results in expectations.json
```

Outside the core profile the addresses fall back to agentmesh.ai, and a banner names each one that did. The suite
runners, `core/run.mjs` and `peering/run.mjs`, take the same options for their own folder and run every profile by
default. The nightly (`.github/workflows/nightly.yml`) runs them against AgentMesh's dev mesh, with
`--agentmesh-operator` on the core suite so that it names the standing test agents and declares the run's keys to the
AgentMesh operator API. Nothing else calls those AgentMesh doors.

## The discipline

A red test is either a code defect or a spec defect, decided explicitly and in writing. Editing a test to make it pass
without saying which of the two it was is not allowed. `expectations.json` in each suite records the last agreed result;
`--ci` fails on a test recorded as `pass` that now fails or errors, and on any `not-validated` result, which means a
credential or SDK the run was asked to use could not be used.
