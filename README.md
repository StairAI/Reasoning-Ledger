# Reasoning Ledger

A tamper-evident audit trail for AI agent reasoning. Every decision step an agent takes — what it observed, how it planned, what it called, what it concluded, and what it did — is recorded as an immutable, timestamped record in a persistent ledger. v0.1 ships server-side persistence and Trust Tier 0 (server timestamps); on-chain anchoring (Tier 1/2) is the v1 milestone.

This repository is the complete Reasoning Ledger platform:

| Package | Description |
|---|---|
| [`api-server/`](./api-server/) | Trace Service — the HTTP API that receives, stores, and serves records |
| [`typescript-sdk/`](./typescript-sdk/) | TypeScript/Node.js client library (`reasoning-ledger-sdk` on npm) |
| [`python-sdk/`](./python-sdk/) | Python client library (`reasoning-ledger` on PyPI) |
| [`schema/`](./schema/) | Canonical JSON Schema (Draft 2020-12) for all record types |
| [`scripts/`](./scripts/) | Codegen script (`codegen.mts`) that generates native bindings from the schema |

---

## Concepts

### Three building blocks

| Concept | Description |
|---|---|
| **Trace** | An agent's append-only history — all records ever submitted for a given `agent_id` |
| **TraceRecord** | One atomic reasoning step; independently timestamped and verifiable |
| **Session** | A group key (`session_id`) that clusters records belonging to one decision cycle. Not a lifecycle entity — there is no open/close; records simply share a string. |

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
| `Other` | Operational | Catch-all for behaviors outside the taxonomy |

A typical decision cycle looks like:

```
session "cycle-001"
├─ Observing       ← trigger arrives
├─ ToolCalling × N ← data gathering
├─ Thinking        ← analysis + decision
└─ Acting          ← commitment
```

---

## Repository layout

```
Reasoning-Ledger/
├─ api-server/          # Trace Service (oRPC + Prisma + PostgreSQL)
├─ typescript-sdk/      # npm package: reasoning-ledger-sdk
├─ python-sdk/          # PyPI package: reasoning-ledger
├─ schema/
│  └─ records.schema.json   # Source of truth for all record types
├─ scripts/
│  └─ codegen.mts           # Generates TS + Python bindings from schema
├─ pnpm-workspace.yaml  # api-server + typescript-sdk are pnpm workspace members
└─ .github/workflows/
   ├─ publish-typescript-sdk.yml
   └─ publish-python-sdk.yml
```

---

## Getting started

### 1. Get an API key

Owner registration (issuing an `api_key`) is handled out-of-band through the Stair AI website or BD onboarding. You receive:

- `api_key` — owner-level secret; used for all SDK calls
- `owner_wallet_address` — the owner's default anchor wallet (custodial or BYOW)

### 2. Register an agent

Use either SDK to register an agent under your owner account. This returns an `agent_id` (UUID v4) you supply to every subsequent SDK call.

**TypeScript**

```typescript
import { LedgerClient } from "reasoning-ledger-sdk";

const { agent_id } = await LedgerClient.registerAgent({
  apiKey: process.env.STAIRAI_API_KEY,
  name: "my-agent",
});
```

**Python**

```python
from reasoning_ledger import LedgerClient, RegisterAgentOpts

reg = LedgerClient.register_agent(RegisterAgentOpts(
    api_key=os.environ["STAIRAI_API_KEY"],
    name="my-agent",
))
agent_id = reg["agent_id"]
```

### 3. Submit records

```typescript
// TypeScript
const client = new LedgerClient({ apiKey: "sl_...", agentId: agent_id });
const session = client.newSession();

await session.submit({
  behavior: "Thinking",
  prompt: "Should I buy or sell?",
  inputs: [],
  output_payload: JSON.stringify({ recommendation: "hold" }),
});
```

```python
# Python
from reasoning_ledger import LedgerClient, LedgerClientConfig

client = LedgerClient(LedgerClientConfig(
    api_key="sl_...",
    agent_id=agent_id,
))
session = client.new_session()

session.submit({
    "behavior": "Thinking",
    "prompt": "Should I buy or sell?",
    "inputs": [],
    "output_payload": '{"recommendation": "hold"}',
})
```

---

## Package documentation

- **TypeScript SDK** — [`typescript-sdk/README.md`](./typescript-sdk/README.md)
- **Python SDK** — [`python-sdk/README.md`](./python-sdk/README.md)
- **API Server** — [`api-server/README.md`](./api-server/README.md)

---

## Schema and codegen

All record types are defined once in [`schema/records.schema.json`](./schema/records.schema.json) (JSON Schema Draft 2020-12). The codegen script regenerates TypeScript and Python bindings from that file:

```sh
pnpm tsx scripts/codegen.mts
```

The pre-commit hook runs this automatically. Never edit the generated files (`src/generated/records.ts`, `src/reasoning_ledger/generated/records.py`) by hand.

---

## License

MIT
