# Reasoning Ledger

An append-only audit trail for AI agent reasoning. Every decision step an agent takes — what it observed, how it planned, what it called, what it concluded, what a person approved, and what it did — is recorded as a timestamped record that cannot be changed once written.

What 1.0 guarantees, concretely:

- **Append-only storage.** In production the server runs under a database account that can add records but never update or delete them ([setup](./api-server/README.md#database-accounts)); every record gets a server timestamp and a position in one total order (`sequence`).
- **Content by hash.** Prompts, outputs and tool payloads are uploaded to a content library and referenced from records by SHA-256, so a record states exactly which bytes it was about. Content can be deleted by the operator; the record's hash still shows it existed.
- **Verifiable exports.** Records can be exported in batches with SHA-256 manifests for write-once storage, and an export can be checked against the database later.
- **Owner isolation.** Every read is limited to the calling owner's data, through the API and in the trace viewer.

On-chain anchoring is not part of 1.0.

This repository is the complete Reasoning Ledger platform:

| Package | Description |
|---|---|
| [`api-server/`](./api-server/) | Trace Service — the HTTP API that receives, stores, and serves records |
| [`typescript-sdk/`](./typescript-sdk/) | TypeScript/Node.js client library (`reasoning-ledger-sdk` on npm) |
| [`python-sdk/`](./python-sdk/) | Python client library (`reasoning-ledger` on PyPI) |
| [`schema/`](./schema/) | Canonical JSON Schema (Draft 2020-12) for all record types |
| [`integration-tests/`](./integration-tests/) | End-to-end suites for both SDKs against a running server, including cross-SDK checks |
| [`scripts/`](./scripts/) | Codegen (`codegen.mts`) and the local test gate (`test-local.mts`) |

---

## Concepts

### Three building blocks

| Concept | Description |
|---|---|
| **Trace** | An agent's append-only history — all records ever submitted for a given `agent_id` |
| **TraceRecord** | One atomic reasoning step, with a server timestamp and a position in the server's total order (`sequence`) |
| **Session** | A group key (`session_id`) that clusters records belonging to one decision cycle. Not a lifecycle entity — there is no open/close; records simply share a string. |
| **Content** | Raw bytes (a prompt, a tool's output, a model's reasoning) stored once per owner under their SHA-256 and referenced from records |

Every record also says who performed the step (`executor`: a model, deterministic code, or a person) and when it was written relative to the step (`record_phase`: before, during or after).

### Behavior taxonomy

Every record carries a `behavior` field that classifies what the agent was doing:

| Behavior | Kind | Description |
|---|---|---|
| `Observing` | Composite | The triggering event that woke the agent (signal or cron) |
| `Planning` | Composite | Goal decomposition into steps |
| `Thinking` | Composite | Analysis, option evaluation, and decision |
| `Acting` | Composite | The terminal commitment that resolves the cycle |
| `Reflecting` | Composite | Post-hoc reasoning over prior behavior |
| `ToolCalling` | Operational | Any external call — API, KB, sub-agent, on-chain read, local function |
| `Attesting` | Oversight | A person's approval, rejection or edit of a pending action, submitted by the application |
| `Other` | Operational | Catch-all for behaviors outside the taxonomy |

A typical decision cycle looks like:

```
session "cycle-001"
├─ Observing       ← trigger arrives
├─ ToolCalling × N ← data gathering
├─ Thinking        ← analysis + decision
├─ Attesting       ← a person signs off (when the action needs it)
└─ Acting          ← commitment
```

---

## Repository layout

```
Reasoning-Ledger/
├─ api-server/          # Trace Service (Astro + oRPC + Prisma + PostgreSQL)
├─ typescript-sdk/      # npm package: reasoning-ledger-sdk
├─ python-sdk/          # PyPI package: reasoning-ledger
├─ integration-tests/   # typescript/, python/ and cross-sdk/ suites
├─ schema/
│  ├─ records.schema.json   # Source of truth for all record types
│  ├─ SCHEMA.md             # Field-by-field reference
│  └─ history/              # Snapshots of earlier schema versions
├─ scripts/
│  ├─ codegen.mts           # Generates TS + Python bindings from the schema
│  └─ test-local.mts        # Local test gate (pnpm test:local)
├─ CHANGELOG.md
├─ pnpm-workspace.yaml
└─ .github/workflows/
   ├─ tests.yml                 # The local gate, on every pull request
   ├─ integration-tests.yml     # Manual: integration suites against a deployed server
   ├─ publish-typescript-sdk.yml
   └─ publish-python-sdk.yml
```

---

## Getting started

```sh
npm install reasoning-ledger-sdk   # TypeScript / Node.js
pip install reasoning-ledger       # Python 3.12+
```

Upgrading from 0.3? See the [changelog](./CHANGELOG.md).

### 1. Get an API key and an endpoint

Every SDK call needs the server's base URL (`endpoint`) and an owner API key; the SDKs have no default server. On the hosted service (`https://api.stair-ai.com`), Stair AI issues the API key. On your own server, register an owner with the administrator token (see [`api-server/README.md`](./api-server/README.md)). The `api_key` is shown once; keep it secret.

### 2. Register an agent

Use either SDK to register an agent under your owner account. This returns an `agent_id` (UUID v4) you supply to every subsequent SDK call.

**TypeScript**

```typescript
import { LedgerClient } from "reasoning-ledger-sdk";

const endpoint = "https://api.stair-ai.com"; // or your own server
const { agent_id } = await LedgerClient.registerAgent({
  apiKey: process.env.STAIRAI_API_KEY,
  endpoint,
  name: "my-agent",
});
```

**Python**

```python
from reasoning_ledger import LedgerClient, RegisterAgentOpts

endpoint = "https://api.stair-ai.com"  # or your own server
reg = LedgerClient.register_agent(RegisterAgentOpts(
    api_key=os.environ["STAIRAI_API_KEY"],
    endpoint=endpoint,
    name="my-agent",
))
agent_id = reg["agent_id"]
```

### 3. Submit records

Content fields take plain values: the SDK uploads a string, bytes or any other JSON value to the content library and puts its reference in the record.

```typescript
// TypeScript
const client = new LedgerClient({ apiKey: "sl_...", agentId: agent_id, endpoint });
const session = client.newSession();

await session.submit({
  behavior: "Thinking",
  executor: "ai",
  record_phase: "post_execution",
  prompt: "Should I buy or sell?",
  inputs: [],
  output_payload: { recommendation: "hold" },
});
```

```python
# Python
from reasoning_ledger import LedgerClient, LedgerClientConfig

client = LedgerClient(LedgerClientConfig(
    api_key="sl_...",
    agent_id=agent_id,
    endpoint=endpoint,
))
session = client.new_session()

session.submit({
    "behavior": "Thinking",
    "executor": "ai",
    "record_phase": "post_execution",
    "prompt": "Should I buy or sell?",
    "inputs": [],
    "output_payload": {"recommendation": "hold"},
})
```

When a person approves, rejects or edits an action, the application records it with `submitAttesting` (Python: `submit_attesting`); see the SDK READMEs.

---

## Package documentation

- **TypeScript SDK** — [`typescript-sdk/README.md`](./typescript-sdk/README.md)
- **Python SDK** — [`python-sdk/README.md`](./python-sdk/README.md)
- **API Server** — [`api-server/README.md`](./api-server/README.md): configuration, database accounts, upgrades, operator commands
- **Integration tests** — [`integration-tests/README.md`](./integration-tests/README.md)

---

## Testing

Everything runs locally, against a throwaway database and a server started on this machine:

```sh
pnpm test:local          # static checks + unit + integration
pnpm test:static         # lint, format and type checks only
pnpm test:unit           # unit suites
pnpm test:integration    # integration suites
```

Needs Node.js 24, pnpm 11, [uv](https://docs.astral.sh/uv/) and a PostgreSQL user that may create databases and roles (see [`scripts/test-local.mts`](./scripts/test-local.mts)). The same gate runs on every pull request ([`.github/workflows/tests.yml`](./.github/workflows/tests.yml)).

---

## Schema and codegen

All record types are defined once in [`schema/records.schema.json`](./schema/records.schema.json) (JSON Schema Draft 2020-12). A field-by-field reference for every record type lives in [`schema/SCHEMA.md`](./schema/SCHEMA.md). The codegen script regenerates the TypeScript, Python and server bindings from that file:

```sh
pnpm codegen
```

The pre-commit hook runs this automatically. Never edit the generated files (`src/generated/`, `src/reasoning_ledger/generated/`) by hand.

The schema version is numbered separately from the SDK and server versions. SDK and server 1.0.0 write schema `0.4`; the server accepts writes only in the current version and keeps every earlier version readable. The label `1.0` was used by SDK 0.1.0 for what is now `0.2`; it is retired and will never be reused.

---

## Releasing the SDKs

Both SDKs are published from GitHub by hand (`workflow_dispatch`), and the version in the manifest decides where the release lands:

| Branch | Version | Published as |
|---|---|---|
| `develop` (deployed to staging) | `1.1.0-rc.1` / `1.1.0rc1` | npm tag `next`, a PyPI pre-release — `npm install` and `pip install` do not pick these up |
| `master` (deployed to production) | `1.1.0` | npm tag `latest`, a PyPI release |

So the version people install by default always matches the production server, and what is released is the same artifact that was already exercised against staging. The workflows refuse a version that is already published, a pre-release from `master`, or a release from `develop`.

---

## License

[MIT](./LICENSE)
