# Reasoning Ledger SDK — Design Document

**Version:** 1  
**Date:** April 25, 2026  
**Author:** Colin Qian  
**Status:** Draft for team review

---

## Table of Contents

1. [Purpose & Scope](#1-purpose--scope)
2. [Conceptual Model](#2-conceptual-model)
3. [Agent Behavior Taxonomy](#3-agent-behavior-taxonomy)
4. [Record Schemas](#4-record-schemas)
5. [Authoritative Fields & Identity](#5-authoritative-fields--identity)
6. [Agent Registration](#6-agent-registration)
7. [SDK API Design](#7-sdk-api-design)
8. [Trace Service API](#8-trace-service-api)
9. [Validation Rules](#9-validation-rules)
10. [Trace Service Architecture](#10-trace-service-architecture)
11. [Wallet Integration](#11-wallet-integration)
12. [Trust & Attestation](#12-trust--attestation)
13. [Roadmap](#13-roadmap)
14. [Open Questions](#14-open-questions)

---

## 1. Purpose & Scope

The Reasoning Ledger SDK is the integration surface for third-party agents to submit reasoning records to Stair AI's Trace Service.

**v1 scope:**
- TypeScript client library (`@stairai/ledger-sdk`)
- Record-oriented submission; idempotent via SDK-generated `record_id`
- Single-record and batch endpoints
- Server-side persistence; record / session / trace retrieval endpoints
- Owner-level wallet provisioning (custodial / BYOW) at owner registration — wallet is collected and stored as owner metadata, ready to be used when v2 anchoring lights up
- Trust Tier 0 (server timestamps); Tier 1–2 scaffolded server-side, not exposed in SDK

**Out of scope for v1, deferred to v2 (see Section 13):** the actual chain-anchoring pipeline — Merkle root computation, Walrus blob upload, SUI commit transactions, BYOW signer invocation. v2 ships anchoring as a *separate backend pipeline* that reads from the server's persistent store and commits to chain, plus a *separate SDK component* for partners to read anchor state directly from chain. The core SDK in v1 interacts with server data only and never produces or reads chain transactions.

**Also deferred:** Python / Go SDKs, field-level encryption, witness / zkTLS / TEE attestation, multi-chain adapters, Blind Sequencer, agent identity lifecycle, schema migration tooling, next-gen SDK with automated code auditing.

---

## 2. Conceptual Model

### 2.1 Three Concepts

| Concept | Definition |
|---|---|
| **Trace** | Agent's long-term reasoning ledger — the append-only history of records attributed to an `agent_id` |
| **TraceRecord** | Atomic unit of submission — one behavior step; independently verifiable |
| **Session** | Group key — records sharing a `session_id` belong to one decision cycle. Not an entity, has no lifecycle |

### 2.2 Structure

```
Agent X's Trace
├─ session "cycle-001"
│  ├─ Observing
│  ├─ ToolCalling × N
│  ├─ Thinking
│  └─ Acting           (terminal record of the decision cycle)
│
├─ session "cycle-002"
│  ├─ Observing
│  └─ Thinking         (no Acting — incomplete cycle; not scored)
│
└─ session "cycle-001" (post-outcome)
   └─ Reflecting       (attached via session_id)
```

### 2.3 Implications

- No session lifecycle (no `open` / `finalize` / `incomplete`)
- Multi-pass reasoning is native — multiple `Thinking` records per session is fine
- Batch is semantically equivalent to single submission (efficiency only)
- `server_ts_utc` stamped on receipt preserves tamper-evidence regardless of submission mode

---

## 3. Agent Behavior Taxonomy

| # | Behavior | Kind | Description |
|---|---|---|---|
| 1 | `Observing` | Composite | The triggering event |
| 2 | `Planning` | Composite | Goal decomposition |
| 3 | `Thinking` | Composite | Analysis + option evaluation + decision (single arc) |
| 4 | `Acting` | Composite | The terminal commitment that resolves the decision cycle |
| 5 | `Reflecting` | Composite | Post-outcome analysis |
| 6 | `ToolCalling` | Operational | Any external invocation: API, KB, sub-agent, on-chain read, local function |
| 7 | `Other` | Operational | Catch-all for behaviors outside the defined taxonomy |

**Other.** An escape hatch for agent behaviors that don't fit the six typed categories. Use sparingly; prefer a typed behavior when one fits.

---

## 4. Record Schemas

### 4.0 Common Base

```typescript
interface BaseRecord {
  schema_version: string;            // Version of the record schema this record conforms to, e.g. "1.0".
                                     // SDK sets this automatically from its bundled constant.
  agent_id: string;
  session_id: string;
  record_id: string;                 // UUID v4. SDK-generated before submission; doubles as the
                                     // idempotency key on (agent_id, record_id).
  behavior: BehaviorType;
  client_ts_utc: number;             // Epoch milliseconds; client-reported timestamp for this record;
                                     // preserved across retries
  notes?: string;
  tags?: string[];

  // Cross-cutting execution context (optional; may be set by the SDK as a default at init)
  model_invocation?: ModelInvocation;

  // Hierarchy (optional; expresses that this record sits under another record's scope)
  parent_record_id?: string;
}

interface ModelInvocation {
  provider: string;                  // e.g. "anthropic", "openai", "stair_internal"
  model_name: string;                // e.g. "claude-opus-4-7"
  model_version?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  temperature?: number;
  finish_reason?: string;            // "stop" | "length" | "refusal" | ...
}
```

All timestamp fields in the schema use **epoch milliseconds (integer, 64-bit)** unless explicitly stated otherwise. Human-readable date strings appear only inside `description` / `*_summary` free-text fields.

**`model_invocation`** captures the LLM call that produced this record, when applicable. Because LLM invocation is cross-cutting — it can back any cognitive behavior (Planning, Thinking, Reflecting) as well as operational ones — it lives on `BaseRecord` rather than as a dedicated behavior type. SDK clients may set a default `ModelInvocation` at initialization that is applied to every submitted record unless overridden on the record itself (see §8.1).

**`parent_record_id`** expresses that this record sits under another record's scope — e.g. a `ToolCalling` that occurred inside a `Thinking` step's execution. Data-flow edges (one record's output feeds another's reasoning) continue to be captured structurally — e.g. `ThinkingInput.input_record_id` references the record whose payload this input corresponds to. An agent is free to emit flat traces (no parent) or nested traces.

**`schema_version`** makes each record self-describing. The SDK stamps it from a bundled constant (`"1.0"` in v0.1) without requiring partner code to set it. The server validates that the version is supported and rejects records with unknown versions. When the schema evolves, older SDKs continue to submit their known version, and the server accepts supported past versions until they are retired — giving partners a migration window rather than a breaking flag day.

**Size limits.** Records and payloads are subject to size limits (per-record, per-batch, and per-field for free-text payloads). v0.1 ships with sketchy starter caps documented in §10; v1 will tighten them based on real telemetry. Records exceeding a cap are rejected client-side with `ValidationError` before any network call.

### 4.1 `Observing`

```typescript
interface ObservingRecord extends BaseRecord {
  behavior: "Observing";
  trigger_source: string;                    // Identifier of the system that sent the trigger
  trigger_type: "signal_trigger" | "cron_trigger";
  external_trigger_id?: string;              // Optional: the trigger's ID within trigger_source
  event_ts_utc?: number;                     // Optional: epoch ms when the trigger event actually
                                             // occurred upstream (as reported by trigger_source).
                                             // Distinct from client_ts_utc, which is when the agent
                                             // received the trigger. Useful for measuring upstream
                                             // latency and for Tier 1/2 reconciliation.
  trigger_description: string;               // Required narrative: plain-language explanation of the
                                             // trigger. Parallel to `goal` on Planning,
                                             // `action_summary` on Acting. Distinct from `notes`
                                             // (optional, across-the-board escape hatch).
  trigger_payload_summary: string;           // Non-sensitive summary (format depends on trigger_type)
}
```

**`trigger_type` semantics**

- **`signal_trigger`** — event-driven. The agent woke up because something happened: a push webhook, a market move, a user request, another agent's call, a threshold breach. Payload describes **what signal arrived**.
- **`cron_trigger`** — time-driven. The agent woke up because a scheduled time was reached. Payload describes **what scheduled check was invoked**.

**`trigger_payload_summary` conventions**

For `signal_trigger` — summarize the signal content:
- Sportradar push: `"Match sr:match:esp_mar minute 47: Spain xG 0.41, possession 62%, shots 8-2"`
- Price alert webhook: `"ETH/USD crossed 3500 (from 3487); source: coinbase"`
- User request: `"User asked: what's the current Spain win probability?"`
- Upstream agent call: `"Oddsmaker signaled divergence > 8pp on ESP vs MAR"`

For `cron_trigger` — name the scheduled task and its configured parameters:
- `"daily_position_review @ 09:00 UTC; scope=all_open_positions"`
- `"hourly_market_scan @ 2026-06-14T19:00:00Z; watchlist=top_50_crypto"`
- `"every_5min_polymarket_sweep; filter=sports,active"`

**`external_trigger_id`** carries the trigger's native identifier inside `trigger_source` when available — Sportradar event UUID, webhook delivery ID, cron run ID, upstream request ID. Optional, but strongly recommended for signal triggers to enable downstream correlation and Tier 1 / Tier 2 verification.

### 4.2 `ToolCalling`

```typescript
interface ToolCallingRecord extends BaseRecord {
  behavior: "ToolCalling";
  tool_meta: Record<string, unknown>;   // Flexible JSON — tool identity, version, category,
                                        // and any category-specific references (see Suggested shapes)
  description: string;                  // Free-form description of this tool call: purpose, context,
                                        // how the input and output relate to the agent's reasoning
  input_payload: unknown;               // Input to the tool (string, object, array — whatever fits)
  output_payload: unknown;              // Output from the tool. If `success: false`, put error info here.
  success: boolean;
}
```

**Identity.** Tool calls are identified by the inherited `record_id` on `BaseRecord`. Other records (e.g. `ThinkingInput.input_record_id`) reference a tool call by that ID.

**LLM invocations are not a tool call.** When a record is *produced via* an LLM — even if that LLM is "invoked" as a tool in the agent's code — use the `model_invocation` field on `BaseRecord` (§4.0) instead. Reserve `ToolCalling` for calls to external APIs, KBs, on-chain reads, local functions, and sub-agents.

**Cross-agent dependencies & nested calls.** Cross-agent reasoning dependencies are captured inside `tool_meta` by convention (see Suggested shapes). Hierarchical composition — e.g. a `ToolCalling` that occurred inside a `Thinking` step — is expressed with `parent_record_id` (§4.0).

**Suggested shapes for `tool_meta`.** Not enforced by v0.1 schema — use whatever makes sense. These are starting points agents should gravitate to, so scoring and UIs can rely on common keys.

```jsonc
// External API
{
  "tool_id": "polymarket_api",
  "tool_version": "v3",
  "category": "external_api",
  "endpoint": "/markets",
  "method": "GET",
  "http_status": 200
}

// On-chain data read
{
  "tool_id": "sui_oracle",
  "category": "on_chain_data",
  "network": "sui_mainnet",
  "contract_id": "0xabc...def",
  "blob_id": "walrus_blob_xyz",
  "referenced_trace_record_id": "trace_oddsmaker_prematch_001",
  "block_timestamp": 1781380020000
}

// Internal knowledge base
{
  "tool_id": "deep_field_kb_v2",
  "category": "internal_kb",
  "store_type": "vector_db",
  "results_count": 4,
  "relevance_score": 0.91
}

// Local function / deterministic compute
{
  "tool_id": "xg_calibration",
  "tool_version": "0.4.2",
  "category": "function"
}

// Sub-agent invocation
{
  "tool_id": "oddsmaker",
  "category": "sub_agent",
  "agent_id": "oddsmaker_v1",
  "invoked_session_id": "om-cycle-0042",
  "referenced_trace_record_id": "trace_oddsmaker_response_001"
}
```

### 4.3 `Planning`

```typescript
interface PlanningRecord extends BaseRecord {
  behavior: "Planning";
  goal: string;
  steps: { index: number; description: string; depends_on?: number[] }[];
  contingencies?: string[];
}
```

### 4.4 `Thinking`

```typescript
interface ThinkingRecord extends BaseRecord {
  behavior: "Thinking";
  prompt: string;                // The reasoning logic / prompt that produced this thinking step
  inputs: ThinkingInput[];       // Inputs considered (may be empty)
  output_payload: string;        // JSON-encoded output of the reasoning
}

interface ThinkingInput {
  input_record_id?: string;      // Optional: references another record's `record_id`
  input_payload: string;         // JSON-encoded payload of this input
}
```

`prompt` carries the reasoning logic — the instructions, template, or system prompt that drove this step. `inputs` are the pieces of evidence fed into that logic; each can either reference another record (`input_record_id`) or carry its own payload, or both. `output_payload` is the structured result the reasoning produced, as a JSON-encoded string.

### 4.5 `Acting`

```typescript
interface ActingRecord extends BaseRecord {
  behavior: "Acting";
  action_type: string;
  target_system: string;
  action_summary: string;
  parameters: Record<string, unknown>;
  dry_run: boolean;
  execution_id?: string;         // Required if target_system is public-chain
                                 // and execution_status === "confirmed"
  execution_status: "confirmed" | "failed" | "simulated" | "pending";
}
```

### 4.6 `Reflecting`

```typescript
interface ReflectingRecord extends BaseRecord {
  behavior: "Reflecting";
  reflected_on_acting_record_id: string;
  outcome: {
    actual_result: string;
    expected_result: string;
    pnl_delta?: number;
  };
  prediction_accuracy: "correct" | "incorrect" | "partial";
  post_mortem: string;
  signal_retrospective: SignalReview[];
  adjustment: string;
}

interface SignalReview {
  input_record_id?: string;      // References an input record considered in the original Thinking
  note: string;                  // Retrospective commentary on how this input should have been weighed
}
```

**Edits triggered by reflection.** When a Reflecting record leads to a concrete change — modifying a config, adjusting a weight, editing a prompt template — emit the change as an `Acting` record in a *new session* whose entry record carries `parent_record_id` pointing at the Reflecting. This preserves the "≤1 Acting per session" rule, gives the edit its own audit trail (`parameters` capturing `target_resource`, `before`, `after`, `change_description`, and optionally a `reviewer` field to distinguish automated from human-approved edits), and makes the causal chain from underperforming outcome → reflection → strategy change queryable via `parent_record_id`. `Reflecting.adjustment` describes the recommendation; the edit-Acting's `parameters` describes the actual change — they can legitimately differ (e.g., reflection recommends a weight of 0.75, reviewer approves 0.70), and that divergence is itself useful audit information.

### 4.7 `Other`

Catch-all for behaviors outside the six typed categories — custom agent operations, environment-specific events, experimental behavior classes. `Other` records are persisted and retrievable, but do not satisfy scoring eligibility and do not contribute to process scores. Prefer a typed behavior when one fits.

```typescript
interface OtherRecord extends BaseRecord {
  behavior: "Other";
  label: string;                     // Short category hint, e.g. "file_edit", "state_mutation"
  data: Record<string, unknown>;     // Freeform payload
}
```

If a pattern emerges across multiple partners (e.g. `"file_edit"` appears consistently), it becomes a candidate for promotion to a typed behavior in a future schema version.

---

## 5. Authoritative Fields & Identity

### 5.1 Timestamps

All timestamp fields in the schema are **epoch milliseconds (integer, 64-bit)**.

| Field | Where | Set by | Preserved on retry |
|---|---|---|---|
| `client_ts_utc` | Every record (`BaseRecord`) | Client (SDK) | Yes |
| `server_ts_utc` | Ack / stored record | Server | No — reflects actual receipt |
| `event_ts_utc` | `Observing` only (optional) | Client (derived from upstream) | Yes |

Trust relies on `server_ts_utc`. `client_ts_utc` is the timestamp the client attached when constructing the record; the server records it but does not verify it.

**Semantic per behavior:**

| Behavior | `client_ts_utc` represents |
|---|---|
| `Observing` | When the agent received the trigger. Separately, `event_ts_utc` (optional) records when the trigger event occurred upstream. |
| `ToolCalling` | When the tool call completed (success or failure) |
| `Planning` | When the plan was finalized |
| `Thinking` | When the reasoning concluded and the decision was made |
| `Acting` | When the action was committed (internal side; external execution timestamp comes from `execution_id`) |
| `Reflecting` | When the post-mortem was written |

### 5.2 Identifiers

| ID | Format | Assigned by | Scope |
|---|---|---|---|
| `agent_id` | UUID v4 | Server | Globally unique; opaque; the canonical handle for an agent |
| `agent name` | Human-readable string | Partner | Unique within an owner; metadata; mutable; **never appears on records** |
| `record_id` | UUID v4 | SDK | Globally unique; doubles as the idempotency key on `(agent_id, record_id)` |
| `session_id` | Partner-chosen string | Agent | Unique within `agent_id` |

The agent's human-readable `name` is for display, search, and resolution only — `agent_id` (UUID) is what the SDK and records use at runtime.

`record_id` is generated by the SDK as a UUID v4 *before* the network call. It both identifies the record globally and serves as the dedup key for retries — if the SDK retries a transient failure, the server matches on `(agent_id, record_id)` and returns the original ack rather than creating a duplicate. There is no separate "client" vs "server" record ID; the SDK owns generation and the server stores the value as-is.

### 5.3 Owner & Agent Identity

Identity in v1 has two levels:

- **Owner** — an organization or account. Identified externally by email; the server maintains an internal `owner_id` for indexing, but it is not part of the SDK or API surface. **The `api_key` is owner-level** — issued once at owner registration. The owner also holds a **default anchor wallet** (`owner_wallet_address`) created at owner registration. One owner can have many agents; billing, quotas, and agent-name idempotency are scoped to the owner.
- **Agent** — a reasoning-producing entity. Identified by `agent_id`. Each agent belongs to exactly one owner in v1 (no shared ownership, no ownership transfer). Agents have **no secret of their own** — every request authenticates with the owner's `api_key` plus the `agent_id` it is acting on; the server enforces that `agent_id` belongs to the `api_key`'s owner. Each agent also gets its **own anchor wallet** (`agent_wallet_address`) created at agent registration; in v1 this is the wallet that signs anchor commitments for that agent's records, giving per-agent on-chain attestation.

The wallet model has two tiers (see §12 for full mechanics):
- **Owner default wallet** — the org's on-chain identity. Used for owner-level metadata, gas funding for the org's anchoring activity, and as a fallback when an agent's own wallet is unavailable.
- **Per-agent wallet** — signs anchors for that specific agent's records. Allows scoring and trust-tier signals to be agent-attributed at the cryptographic layer.

Wallet *mode* (custodial vs BYOW) is set once at owner registration and applies to both tiers — owner default and every agent under that owner inherit the same mode. Wallets are collected and stored in v0.1 but are not used to sign anything until the v1 anchoring pipeline ships.

`agent_id` is the attribution key stamped onto every record. Records carry no owner or wallet reference — auth is via `api_key`, and the server maps `api_key → owner → set of agent_ids → per-agent wallets` internally.

Deeper identity lifecycle (agent versions, ownership transfer, external identity import, BYOI signing) is deferred to v2.

---

## 6. Owner & Agent Registration

### 6.1 Purpose

Registration is two-stage:

1. **Owner registration** (out-of-band) — done once per partner organization through the Stair AI website or BD onboarding flow, **not via the SDK**. Issues the `api_key`, provisions the **owner default wallet** (`owner_wallet_address`), and locks in the wallet *mode* (custodial or BYOW) for the entire owner. The mode and api_key are shared by every agent the owner subsequently creates.
2. **Agent registration** (via SDK) — repeated as the owner adds more agents. Authenticated by the owner's `api_key`. Returns an `agent_id` and an **agent-specific anchor wallet** (`agent_wallet_address`) provisioned in the same mode the owner chose. No additional secret is issued.

Both wallets are collected and stored as metadata in v0.1; the v1 anchoring pipeline (§11.2, §12) is what actually signs on-chain transactions with them. Splitting these stages keeps secrets and owner-level wallet provisioning out of partner agent code, where they would otherwise be checked in or leak through retries. The SDK only ever sees the already-issued `api_key`.

### 6.2 What Each Stage Produces

**Owner registration (out-of-band, via website / BD):**

| Artifact | Notes |
|---|---|
| `api_key` | Authentication secret for the owner; shown once at registration; rotated via the website / admin tooling |
| `owner_wallet_address` | The owner's default anchor wallet. Custodial: generated by Stair AI. BYOW: the address the owner supplied during onboarding. Single default per owner; serves as the org's on-chain identity and as a fallback when an agent does not have its own wallet. |
| Wallet mode | Custodial or BYOW. Locked at owner registration; applies to the owner default wallet and to every agent wallet provisioned afterwards. |
| Optional metadata | Display name, website, contact email |

**Agent registration (via SDK):**

| Artifact | Notes |
|---|---|
| `agent_id` | Server-assigned UUID v4; the canonical handle; belongs to the owner identified by the `api_key` used to create it |
| `agent_wallet_address` | The agent's own anchor wallet, provisioned in the owner's wallet mode. Custodial: generated by Stair AI per agent. BYOW: supplied by the partner in the `wallet` field; if omitted, falls back to the owner's default wallet. |
| Optional metadata | Display name (`name`), description, website, tags. `name` is human-readable and mutable; never used as a runtime identifier. |

### 6.3 Owner Registration (out-of-band)

Owner registration happens **outside the SDK** — through the Stair AI website self-serve flow or via a BD onboarding conversation. It is a one-time setup per partner organization and produces:

- The owner's `api_key` (shown once; partner stores it as a secret)
- The owner's `owner_wallet_address` — the default wallet (custodial: generated by Stair AI; BYOW: supplied by the partner during onboarding)
- The wallet *mode* (custodial or BYOW), which applies to all subsequent agent registrations under this owner
- Optional metadata (display name, website, contact email)

The wallet mode chosen here is sticky — every agent created afterwards inherits it. Switching modes mid-life is not supported in v0.1 (see §12.5). Both the owner default wallet and every per-agent wallet are collected and stored at v0.1 registration; none are used to sign anything until the v1 anchoring pipeline ships.

The corresponding HTTP endpoints (`POST /v1/owners`, `PATCH /v1/owners/me`, `POST /v1/owners/me/rotate-key` — see §9) are exposed on the Trace Service for the website / admin tooling to call. They are **not** part of the SDK surface — partners do not invoke them programmatically from agent code.

### 6.4 Agent Registration

Authenticated by the owner's `api_key`. Returns an `agent_id` and an `agent_wallet_address`; no new secret is issued — the same `api_key` is reused with the new `agent_id`. The agent's wallet is provisioned in whatever mode the owner picked at §6.3.

**Custodial mode (Stair AI manages all wallets).** No wallet field needed; the server generates a fresh wallet for each agent automatically:

```typescript
const { agent_id, agent_wallet_address } = await LedgerClient.registerAgent({
  apiKey: process.env.STAIRAI_API_KEY,      // Owner-level api_key from §6.3
  name: "deep_field",                       // Partner-chosen; unique within the owner's scope
  metadata: {
    description: "Multi-step football match predictor",
    tags: ["sports", "prediction"],
  },
});
// agent_wallet_address is a fresh Stair-AI-managed address generated for this agent.
```

**BYOW mode (partner manages all wallets).** The partner may supply a per-agent wallet address; if omitted, the agent uses the owner default wallet:

```typescript
const { agent_id, agent_wallet_address } = await LedgerClient.registerAgent({
  apiKey: process.env.STAIRAI_API_KEY,
  name: "deep_field",
  wallet: { address: "0xAGENT_SPECIFIC_SUI_ADDRESS" },   // Optional in BYOW mode
  metadata: {
    description: "Multi-step football match predictor",
    tags: ["sports", "prediction"],
  },
});
// If `wallet` is omitted in BYOW mode, agent_wallet_address echoes the owner default.
```

After registration the partner initializes `LedgerClient` with the owner's `api_key` plus the new `agent_id` as in §8.1. Adding more agents is just additional `registerAgent` calls — no further owner setup, no new api_key.

### 6.5 Idempotency

- **Owner registration** is idempotent on `email` — the website flow returns the existing owner without creating a new one. `api_key` is **not** re-disclosed on repeat calls; rotation uses a separate admin endpoint.
- **Agent registration** is idempotent on `(owner, name)` — repeating the SDK call returns the existing `agent_id` and `agent_wallet_address`. A `wallet` argument in a repeat call is **ignored**; changing an agent's wallet goes through a separate update endpoint (deferred to v1).

### 6.6 v1 Limitations

- One active `api_key` per owner
- One default wallet per owner; one wallet per agent (additional wallets per agent deferred to v2)
- Wallet mode (custodial vs BYOW) is locked at owner registration and uniform across owner + agents
- Agent wallet rotation/replacement deferred to v1
- No owner-scoped listing endpoints (e.g. "list all my agents") in v1; deferred to v2
- No version management (all records submitted under same `agent_id` regardless of internal model changes)
- No ownership transfer (an agent cannot be moved to a different owner)
- No shared ownership (an agent belongs to exactly one owner)
- No revocation beyond key rotation

Comprehensive identity and org management → v2.

---

## 7. SDK API Reference

This section is the canonical surface of the Reasoning Ledger SDK across languages. Signatures are written in a language-neutral pseudo-IDL — concrete bindings (TypeScript first, Python and Go later) follow the idioms of their host language but expose the same identifiers, parameters, and return shapes. The next section walks through these symbols in usage examples.

### 7.1 Public Surface (Overview)

| Group | Symbols |
|---|---|
| Static factory functions | `LedgerClient.registerAgent`, `LedgerClient.resolveAgentId` |
| Client | `LedgerClient` (constructor + instance methods) |
| Session | `Session` (instance methods) |
| Helpers / utilities (§7.7) | `newRecordId`, `nowEpochMs`, `isValidRecordId` |
| Configuration types (§7.8) | `LedgerClientConfig`, `RetryConfig`, `WalletConfig`, `ModelInvocation` |
| Response types (§7.9) | `RecordAck`, `BatchAck`, `RecordError`, `AgentRegistration` |
| Errors (§7.10) | `LedgerError` (base) and subclasses |
| Record types (re-exported) | All record interfaces from §4 |

Anything not listed in this section is **internal** and may change without notice. Importing or reflecting into private symbols is unsupported.

---

### 7.2 `LedgerClient.registerAgent` (static)

Register a new agent under an existing owner. Provisions a per-agent anchor wallet in whatever mode the owner chose at registration (§6.3).

```
registerAgent(opts) -> AgentRegistration

opts:
  api_key:    string                — owner-level api_key (issued out-of-band per §6.3)
  name:       string                — partner-chosen human-readable name; unique within owner
  wallet?:    AgentWalletInput      — BYOW only; optional. Supplies a per-agent address.
                                       In BYOW mode, if omitted, the agent inherits the owner's
                                       default wallet. In custodial mode this field is ignored
                                       (the server always generates a fresh per-agent wallet).
  metadata?:  AgentMetadata         — optional display fields (description, website, tags)

AgentWalletInput:
  address: string                   — partner-owned address recorded as the agent's anchor author
  signer?: function(tx_bytes: bytes) -> bytes
                                    — optional partner signer for v1 anchoring

returns: AgentRegistration          — { agent_id, name, agent_wallet_address, created_at }
                                       (see §7.9)
```

**Idempotent** on `(owner, name)`. Repeating with the same `name` under the same `api_key` returns the existing agent (including its `agent_wallet_address`) without creating a new one. A `wallet` argument in a repeat call is ignored.

**Errors:** `AuthError`, `ValidationError`, `NetworkError`, `ServerError`.

---

### 7.3 `LedgerClient.resolveAgentId` (static)

Look up an existing agent's `agent_id` by name. Use this when only the human-readable name is on hand (dev shells, ops scripts, environments where the UUID wasn't persisted). Best practice: call once at startup and cache the result; do not call per-request.

```
resolveAgentId(opts) -> string

opts:
  api_key: string
  name:    string

returns: agent_id (UUID v4) of the matching agent under the calling owner
```

**Errors:** `AuthError`, `NotFoundError`, `NetworkError`, `ServerError`.

---

### 7.4 `LedgerClient` Constructor

```
LedgerClient(config: LedgerClientConfig) -> LedgerClient
```

Construct a client bound to a single agent. The constructor performs no network call; it stores configuration and prepares the HTTP transport. The api_key and agent_id are validated lazily on the first request.

`LedgerClientConfig` is defined in §7.8.

---

### 7.5 `LedgerClient` Instance Methods

#### `submit(record) -> RecordAck`

Submit one record.

```
submit(record) -> RecordAck

record: a Record (any of the 7 behavior types in §4) with these caveats:
  - record_id:       optional; SDK fills with a fresh UUID v4 if omitted
  - schema_version:  optional; SDK fills from the bundled constant
  - client_ts_utc:   optional; SDK fills with nowEpochMs() if omitted
  - agent_id:        injected from the LedgerClient; ignored if supplied

returns: RecordAck (§7.9)
```

**Behavior:** validates the record locally per §10 client-side rules; on failure, raises `ValidationError` synchronously and does not contact the server. On success, sends a single submission request, retrying transient failures per `RetryConfig`. The same `record_id` is reused across retries — the server matches `(agent_id, record_id)` and returns the original ack with `is_duplicate: true` if the prior attempt landed.

**Errors:** `ValidationError`, `AuthError`, `RateLimitError`, `NetworkError`, `ServerError`, `IdempotencyConflictError` (raised when the same `record_id` is reused with a different body).

#### `submitBatch(records) -> BatchAck`

Submit up to 50 records in one request.

```
submitBatch(records) -> BatchAck

records: list of Record values, max 50, with the same omit-and-fill rules as submit

returns: BatchAck (§7.9) — results array preserves input order; entries are
         RecordAck on success and RecordError on per-record failure
```

Per-record validation runs locally; only locally-valid records are sent. Partial server-side failure does **not** raise — inspect `BatchAck.results` to find per-record errors. Batch-level failures (auth, oversized batch, transport) raise as for `submit`.

#### `getRecord(record_id) -> Record`

Fetch a single stored record.

```
getRecord(record_id: string) -> Record
```

**Errors:** `AuthError`, `NotFoundError`, `NetworkError`, `ServerError`.

#### `getSession(session_id) -> SessionFetch`

Fetch every record submitted under `(agent_id, session_id)`.

```
getSession(session_id: string) -> SessionFetch

SessionFetch:
  session_id: string
  records:    list of Record, ordered by server_ts_utc ascending
```

#### `getTrace(opts?) -> TracePage`

Paginated read of the calling agent's full trace.

```
getTrace(opts?) -> TracePage

opts (all optional):
  before:  string  — record_id cursor; returns records older than this
  limit:   number  — default 100, max 500

TracePage:
  records:     list of Record
  next_cursor: string or null
```

#### `newSession(session_id?) -> Session`

Local-only convenience. Returns a `Session` (§7.6) bound to a `session_id` — caller-supplied or SDK-generated. No network call.

```
newSession(session_id?: string) -> Session
```

---

### 7.6 `Session` Instance Methods

A `Session` is local SDK sugar that pins a `session_id` so callers don't have to pass it on every record. There is no server-side session lifecycle; `Session` is purely a convenience wrapper around the underlying `LedgerClient`.

```
Session.id          : string                          (read-only property; the bound session_id)

Session.submit(record)        -> RecordAck            (same as LedgerClient.submit, but
                                                       session_id is auto-injected)
Session.submitBatch(records)  -> BatchAck             (same as LedgerClient.submitBatch, but
                                                       session_id is auto-injected on each record)
```

Same errors as the corresponding `LedgerClient` methods.

---

### 7.7 Helpers / Utilities

Standalone functions, exported alongside the classes. They take no `LedgerClient` instance — they are pure utilities partners can call to align their own code with what the SDK does internally.

#### `newRecordId() -> string`

Generate a fresh UUID v4 suitable for use as a `record_id`. Use when constructing a parent-child pair where the child's `parent_record_id` must reference an as-yet-unsubmitted parent. The SDK calls this internally when `record_id` is not supplied to `submit`.

#### `nowEpochMs() -> number`

Returns the current time as an integer epoch-millisecond. The SDK uses this primitive whenever `client_ts_utc` is omitted from a submitted record. Exposed so partner code that needs to stamp timestamps stays consistent with what the SDK records.

#### `isValidRecordId(value: string) -> boolean`

True iff `value` is a syntactically valid UUID v4. Useful for validating record IDs read from external systems before passing them to `parent_record_id` or `input_record_id`.

This helper group is the home for any future small utilities of the same shape — record-id parsing, schema-version comparison, etc. Partners should expect the list to grow over time without breaking changes.

---

### 7.8 Configuration Types

```
LedgerClientConfig:
  api_key:                  string
  agent_id:                 string                  — UUID v4 from registration
  environment?:             "production" | "staging" | "development"   — default "production"
  endpoint?:                string                  — override the Trace Service base URL
  default_model_invocation?: ModelInvocation        — applied to every submitted record unless
                                                       the record sets its own model_invocation;
                                                       see §4.0
  retry?:                   RetryConfig
  http_transport?:          HttpTransport           — language-specific hook to override
                                                       network calls (for tests / instrumentation)

RetryConfig:
  attempts:    number          — default 3 (one initial + two retries)
  backoff_ms:  list of number  — default [500, 1000, 2000]

WalletConfig (tagged union):
  CustodialWalletConfig:  { mode: "custodial" }
  ByowWalletConfig:       { mode: "byow",
                            address: string,
                            signer?: function(tx_bytes: bytes) -> bytes }
```

`WalletConfig` is **not** a field on `LedgerClientConfig` — wallet mode is established at owner registration (§6.3) and is not reconfigured at client construction. The type is exported for partners building owner-onboarding tooling and for the v2 anchoring SDK component.

`ModelInvocation` is re-exported from §4.0; the shape is unchanged.

---

### 7.9 Response Types

```
RecordAck:
  record_id:      string    — echoes the UUID the SDK submitted
  session_id:     string
  server_ts_utc:  number    — epoch ms; authoritative timestamp for trust purposes
  is_duplicate:   boolean   — true if (agent_id, record_id) was already on file

BatchAck:
  batch_id:  string                          — server-assigned, opaque; for ops/debug
  results:   list of (RecordAck | RecordError)  — same order as the submitted batch

RecordError:
  record_id: string         — identifies which record failed
  code:      string         — stable machine-readable code (see §7.10)
  message:   string         — human-readable; for logs, not for branching

AgentRegistration:
  agent_id:               string    — UUID v4
  name:                   string
  agent_wallet_address:   string    — the agent's per-agent anchor wallet (custodial:
                                       generated by Stair AI; BYOW: partner-supplied or
                                       inherited from the owner's default wallet)
  created_at:             number    — epoch ms
```

---

### 7.10 Errors

The SDK raises a single error hierarchy. All errors carry a stable `code` string and an optional `details` map of machine-readable supplementary info. Bindings should expose these as exceptions in the host language's idiom (TS classes, Python exception classes, Go error types implementing a common interface).

```
LedgerError (base):
  code:     string
  message:  string
  details?: map of string -> any
```

| Class | `code` | When raised |
|---|---|---|
| `ValidationError` | `validation_failed` | Local schema check failed; the record never reached the network. `details.field` and `details.reason` carry the specific violation. |
| `AuthError` | `auth_invalid` / `auth_expired` | API key rejected or unknown to the server. |
| `RateLimitError` | `rate_limited` | Server returned a rate-limit signal. `details.retry_after_ms` carries the suggested wait. |
| `NetworkError` | `network_failed` | Request never reached the server (DNS, timeout, abort) after exhausting retries. |
| `ServerError` | `server_5xx` | Server returned a non-retryable 5xx. `details.status` carries the HTTP status. |
| `IdempotencyConflictError` | `record_id_conflict` | The same `record_id` was previously submitted with a different body. |
| `NotFoundError` | `not_found` | Lookup target (record, session, agent) does not exist or is not visible to the calling owner. |

Partners may branch on either the class hierarchy or on `code`. New error subclasses may be added in minor versions; partners writing forward-compatible error handling should fall through to `LedgerError` for unknown subtypes.

---

## 8. SDK Usage Examples

### 8.1 Client Initialization

`agent_id` is a server-assigned UUID. The agent's human-readable `name` (chosen by the partner at registration) is *metadata only* — it is mutable, scoped to the owner, and never appears on records. Code paths inside the SDK use `agent_id` exclusively; this avoids a hidden name-resolution round trip on every client construction and prevents a rename from silently redirecting which agent your code submits as.

The recommended workflow:

**1. First time — capture `agent_id` at registration (§6.4) and persist it:**

```typescript
const { agent_id } = await LedgerClient.registerAgent({
  apiKey: process.env.STAIRAI_API_KEY,
  name: "deep_field",
  metadata: { description: "Multi-step football match predictor" },
});
// Store agent_id in your secret manager / env var / config — alongside the api_key.
```

**2. Subsequent runs — construct the client with the persisted `agent_id`:**

```typescript
import { LedgerClient } from "@stairai/ledger-sdk";

const client = new LedgerClient({
  apiKey: process.env.STAIRAI_API_KEY,        // Owner-level api_key (issued out-of-band per §6.3)
  agentId: process.env.STAIRAI_AGENT_ID,      // UUID from §6.4
  environment: "production",

  // Optional: default ModelInvocation applied to every submitted record.
  // Any record may override by setting its own model_invocation.
  defaultModelInvocation: {
    provider: "anthropic",
    model_name: "claude-opus-4-7",
  },
});
```

**3. Resolution helper — for partners who only have the name on hand** (e.g. dev shells, ops scripts, environments where the UUID wasn't persisted):

```typescript
const agentId = await LedgerClient.resolveAgentId({
  apiKey: process.env.STAIRAI_API_KEY,
  name: "deep_field",
});
const client = new LedgerClient({ apiKey: process.env.STAIRAI_API_KEY, agentId, ... });
```

`resolveAgentId` is a thin wrapper over `GET /v1/agents?name=...` — best practice is to call it once at startup (or in a one-time bootstrap script) and cache the result, not on every request.

The wallet mode is established at owner registration (§6.3) and applies to every agent under the owner — it does not need to be passed at client init.

### 8.2 Submission

```typescript
// Single record
const ack = await client.submit({
  session_id: "df-cycle-001",
  behavior: "Observing",
  client_ts_utc: 1781380020000,
  /* behavior-specific fields */
});

// Batch (max 50)
const acks = await client.submitBatch([ /* records */ ]);

// Session helper (SDK-side sugar; no server lifecycle)
const session = client.newSession();
await session.submit({ behavior: "Observing", /* ... */ });
await session.submit({ behavior: "Acting", /* ... */ });
```

### 8.3 Retry

In-memory only. Exponential backoff (500ms, 1s, 2s by default, configurable). Same `record_id` on retry → server returns original ack with `is_duplicate: true`. No persistent local sink in v1.

### 8.4 Response Shapes

```typescript
interface RecordAck {
  record_id: string;             // The same UUID the SDK generated and submitted; echoed back
  session_id: string;
  server_ts_utc: number;         // Epoch ms — authoritative timestamp for trust purposes
  is_duplicate: boolean;         // true if (agent_id, record_id) was already on file
}

interface BatchAck {
  batch_id: string;
  results: Array<RecordAck | RecordError>;
}

interface RecordError {
  record_id: string;             // Identifies which submitted record failed
  code: string;
  message: string;
}
```

---

## 9. Trace Service API

**Control plane (owner & agent lifecycle — see Section 6):**

Owner endpoints are reached only by the Stair AI website / admin tooling — they are not invoked from the SDK. Agent endpoints are SDK-facing.

*Backend / website only — not exposed via SDK:*

| Endpoint | Purpose |
|---|---|
| `POST /v1/owners` | Register a new owner (or resolve existing by email); returns `api_key` and `anchor_wallet_address` |
| `PATCH /v1/owners/me` | Update owner metadata (auth: `api_key`) |
| `POST /v1/owners/me/rotate-key` | Issue a new `api_key`; invalidate previous (auth: current `api_key`) |

`/v1/owners/me` resolves to the owner identified by the `api_key`, so neither the website nor partners ever need to pass `owner_id`.

*SDK-facing:*

| Endpoint | Purpose |
|---|---|
| `POST /v1/agents` | Register a new agent under the calling owner (auth: `api_key`); returns `agent_id` (UUID v4) |
| `GET  /v1/agents?name=...` | Resolve the calling owner's agent by `name`; returns `agent_id` and metadata. Backs `LedgerClient.resolveAgentId` (§7.3). |
| `GET  /v1/agents/:agent_id` | Fetch agent metadata (public fields only) |
| `PATCH /v1/agents/:agent_id` | Update agent metadata (auth: owner's `api_key`) |

**Data plane (record submission & retrieval):**

| Endpoint | Purpose |
|---|---|
| `POST /v1/records` | Submit one record |
| `POST /v1/records:batch` | Submit ≤50 records; partial failure allowed |
| `GET  /v1/records/:id` | Fetch a record incl. chain refs |
| `GET  /v1/sessions/:id?agent_id=...` | Fetch all records in a session |
| `GET  /v1/traces/:agent_id` | Paginated trace for an agent |

Idempotency: dedup on `(agent_id, record_id)`. Duplicate → original ack returned with `is_duplicate: true`.

---

## 10. Validation Rules

### 10.1 Schema Rules

**Client-side (hard errors):** valid `behavior`, non-empty `schema_version`, non-empty `session_id`, `record_id` is a valid UUID v4, `client_ts_utc` positive integer (epoch ms), `ToolCallingRecord.tool_meta` must be a JSON-serializable object, `Thinking.prompt` and `Thinking.output_payload` non-empty strings, `Acting.execution_id` present when target is public-chain + confirmed, `OtherRecord.data` must be a JSON-serializable object, all size limits in §10.2 respected.

**Server-side:** API key ↔ `agent_id` match, `schema_version` must be a supported version, `(agent_id, record_id)` unique (duplicate → return original ack with `is_duplicate: true`), ≤1 `Acting` per session, `parent_record_id` (when set) resolves to an existing record under the same `agent_id`, `server_ts_utc` server-assigned, batch ≤50, all size limits in §10.2 respected (server re-checks).

**Intentional non-rules:** no "first record must be Observing," no session lifecycle, no session timeout, no enforced hierarchy shape (traces may be flat or nested).

### 10.2 Size Limits

Sketchy starter caps for v0.1 — placeholders to be tightened in v1 based on real telemetry. Both SDK (client-side) and server enforce. Records exceeding any cap are rejected with `ValidationError` (code `validation_failed`, `details.field` and `details.limit_bytes` set).

| Scope | Cap | Notes |
|---|---|---|
| Per-record total (JSON-encoded) | 64 KB | Across all fields combined; the dominant constraint for most records |
| Per-batch total (JSON-encoded) | 1 MB | Sum of all records in a `submitBatch` call; with batch size of 50, this leaves ~20 KB average per record |
| `notes` (BaseRecord) | 2 KB | Lightweight annotation; not for payload-shaped content |
| `tags` (BaseRecord) | 32 entries, 64 chars each | Tags are facets, not free text |
| `tool_meta` (ToolCalling) | 16 KB | Includes any nested ref-shape conventions |
| `input_payload` (ToolCalling) | 16 KB | |
| `output_payload` (ToolCalling) | 32 KB | Larger ceiling for outputs since responses are often the longer artifact |
| `prompt` (Thinking) | 16 KB | |
| `output_payload` (Thinking) | 32 KB | JSON-encoded reasoning result |
| `parameters` (Acting, JSON-encoded) | 16 KB | |
| `data` (Other, JSON-encoded) | 16 KB | |
| `trigger_payload_summary` (Observing) | 4 KB | A summary, not the payload itself |

A trace (the per-agent append-only log) has no fixed size cap in v0.1 — it grows freely. Per-session aggregate caps may be added in v1 once real distributions are observed.

If a partner has a legitimate use case for payloads exceeding these caps (large model outputs, structured datasets), the v1 plan is to support out-of-band content addressing — the record carries a content hash + retrieval URI, and the bulk lives in object storage. v0.1 does not support this; partners must summarize in-line.

---

## 11. Trace Service Architecture

### 11.1 v1 — Server-Only

```
Agent ──HTTP──▶ Trace Service ──▶ Persistent Store (records, sessions, owners)
```

**On `POST /v1/records`:**
1. Auth & validate (api_key ↔ agent_id, schema_version, behavior-specific rules)
2. Dedup check on `(agent_id, record_id)` (return original ack with `is_duplicate: true` on match)
3. Stamp `server_ts_utc`, persist
4. Return ack
5. Background: enqueue for Trust Tier 2 analysis

No chain interaction. No Walrus, no SUI. The wallet collected at owner registration sits idle in the owners table until v2.

### 11.2 v2 — Anchoring Pipeline (preview)

v2 adds chain anchoring as a **separate backend pipeline** that runs alongside the v1 record-ingestion path, not inside it:

```
Trace Service ──▶ Persistent Store
                      │
                      ▼
               Anchoring Pipeline ──▶ Walrus DA (blob)
                                  └─▶ SUI Trace Ledger (anchor)
```

The pipeline reads completed sessions from the store, computes Merkle roots, uploads bundles to Walrus, and submits anchor transactions to SUI signed with the owner's wallet (custodial: signed by Stair AI's KMS; BYOW: signed by the partner via the SDK's `signer` callback). Record submission stays synchronous and unaffected; anchoring is asynchronous and recoverable independently.

A separate SDK component (also v2) lets partners read anchor state — `merkle_root`, `walrus_blob_id`, `sui_tx_id`, `anchored_at_utc` — directly from chain to verify a session was anchored without trusting the Trace Service.

**Anchoring trigger (v2):** the pipeline anchors a session when its terminal `Acting` record has been persisted. `Reflecting` records anchor as a separate, linked commitment after the original anchor. Records that arrive after a session has been anchored are stored with `post_anchor: true` and excluded from that session's Merkle tree (they would form their own anchor on a subsequent eligible event).

---

## 12. Wallet Integration

> **What is v0.1 vs v1 in this section.** Wallet *provisioning* — collecting the custodial vs BYOW choice and generating or recording addresses — happens at v0.1 owner registration (owner default wallet) and at every v0.1 agent registration (per-agent wallet). Wallet *use* — actually signing on-chain anchor transactions — is part of the v1 anchoring pipeline (§11.2). The BYOW signer callback shape defined here is part of the v0.1 SDK API for forward compatibility, but in v0.1 it is never invoked because no anchor transactions are produced.

### 12.1 Two-Tier Wallet Hierarchy

Each owner has **two tiers** of anchor wallet:

- **Owner default wallet** (`owner_wallet_address`) — created at owner registration. The org's on-chain identity. Used for owner-level metadata, gas funding for the org's anchoring activity, and as a fallback when a specific agent does not have its own wallet.
- **Per-agent wallet** (`agent_wallet_address`) — created at each agent registration. Signs anchor commitments for that specific agent's records. Gives per-agent on-chain attestation, so scoring and trust-tier signals can be cryptographically agent-attributed.

In v1 anchoring, the default behavior is for the agent's own wallet to sign anchors for that agent's sessions. The owner default wallet steps in only when an agent has no per-agent wallet (BYOW with no override on registration), and for any owner-level on-chain operations.

### 12.2 Two Modes

Partners choose one mode at **owner registration** (§6.3). The choice is locked at the owner level — both the owner default wallet and every per-agent wallet under that owner are provisioned in the same mode.

| Mode | Wallet ownership | Signing | Gas |
|---|---|---|---|
| **Custodial** (default) | Stair AI creates and holds the SUI wallets — owner default + one per agent | Stair AI signs anchor txs | Stair AI pays |
| **BYOW** (bring your own wallet) | Partner owns the SUI wallets — owner default supplied at owner registration; per-agent supplied at agent registration (or omitted to inherit owner default) | Partner signs via SDK hook; Stair AI service submits | Partner pays |

Both modes produce identical trace records and anchors on-chain. The difference is only in *who owns the key that signs the anchor*.

### 12.3 Custodial Mode (Zero Web3 Experience Required)

- Owner registration: Stair AI provisions the owner default wallet
- Each agent registration: Stair AI provisions a fresh per-agent wallet
- All wallet keys held in Stair AI's KMS (HSM-backed)
- All anchor txs signed and submitted by Stair AI
- Partner has no on-chain exposure and no gas management

In v1 anchoring, Stair AI signs each agent's session anchors with that agent's wallet — giving the on-chain record per-agent attestation even though the partner never touches a key.

### 12.4 BYOW Mode

- Owner registration: partner supplies the owner default address (and optional `signer` callback for v1)
- Agent registration: partner may supply a per-agent address via the `wallet` field on `registerAgent` (§7.2). If omitted, the agent inherits the owner default wallet.
- In v1, when an anchor is ready to sign, the server prepares the tx bytes for the wallet that should sign it (per-agent if set, owner default otherwise), pushes them to the SDK via a pending-signature channel, the SDK invokes the partner's `signer`, and the server submits the signed tx to SUI

The partner thus has flexibility: distinct per-agent wallets give each agent its own on-chain identity (preferred when agents will be scored or staked independently); reusing the owner default across agents is a degenerate case where every agent's anchor is co-signed by the same key.

### 12.5 Server-Side Responsibilities

In both modes the Trace Service:
- Builds the anchor tx (Merkle root + Walrus blob ID + metadata)
- Picks the signing wallet — agent's own if set, owner default otherwise
- Submits to SUI after signing
- Records `anchor_author_address` with each session anchor (matches the wallet that actually signed)

The `anchor_author_address` is surfaced in `GET /v1/sessions/:id` so consumers can distinguish custodial anchors (Stair AI signer) from partner-signed anchors, and per-agent anchors from owner-default anchors.

### 12.6 Migration & Limitations

- The owner's wallet *mode* (custodial vs BYOW) is locked at owner registration; switching modes mid-life is not supported in v0.1.
- Per-agent wallet *replacement* is not supported in v0.1; the agent's wallet is fixed at registration. Replacement / rotation deferred to v1.
- Partner-signing at the **record** level (currently only anchor-level; records themselves are unsigned). Record-level BYOI signing → v2.
- Wallet recovery / key rotation for custodial wallets — KMS-level recovery only in v1.
- Multi-sig anchor authorization — deferred.

---

## 13. Roadmap

### v0.1 — Foundation

- **Base record model:** `BaseRecord` with `record_id`, `session_id`, `agent_id`, `client_ts_utc`, `schema_version`, `model_invocation`, `parent_record_id`.
- **Base behaviors:** 7 record types — Observing, ToolCalling, Planning, Thinking, Acting, Reflecting, Other.
- **TypeScript SDK:** `LedgerClient`, `Session`, helper utilities, validation, retry, error hierarchy.
- **Reasoning Ledger Server:** owner & agent control plane, record submission and retrieval, persistent store, no chain interaction.
- **Python SDK:** language port of the TypeScript surface; conforms to the same record schema and HTTP contract.

### v1 — Official Release

- **Blockchain integration:** Walrus DA + SUI Trace Ledger commits as a separate backend pipeline that reads from the server's persistent store.
- **Data signal on-chain pipelines:** anchor publishing, signal subscription endpoints, and a chain-reader SDK component for partners verifying anchor state directly from chain.
- **Basic encryption:** field-level encryption for sensitive payloads (`output_payload`, `tool_meta` regions); partner-held keys.
- **Schema versioning & migration tooling:** declared schema versions, server-side multi-version acceptance, partner migration helpers.
- **Trust Tier 1–2 surfacing:** oracle reconciliation for public-chain Acting records; behavioral-consistency analyzer results exposed to partners.

### v2 — Ecosystem Expansion

- **Data model expansion:** new typed behaviors promoted from common `Other` patterns; richer cross-record references; multi-agent composition primitives.
- **Go SDK:** language port; expands the supported runtime matrix beyond TS / Python.
- **Multi-chain adapter:** Celestia, EigenDA, Ethereum L2s, Solana — chain-agnostic anchor backend.
- **Blind Sequencer:** independent timestamping service that defends against post-hoc trace fabrication.
- **Agent skill:** dual-use distribution of the Reasoning Ledger as an agent skill — (a) dev-time integration into Claude Code / Codex / similar, surfacing correct schemas and call patterns into generated code; (b) runtime skill consumed by an LLM-driven agent so reasoning records are emitted at the right phases of execution.
- **Use-case-specific frameworks:** opinionated wrappers for trading, research, coding, and operations agents — pre-wired observing/thinking/acting patterns.
- **Scoring integration:** RAID score consumption surface in the SDK; score retrieval, threshold subscription, score-aware client-side logging.

### v3 — Cryptographic Trust

- **Backtest framework:** replay historical traces against alternative agent strategies; standalone tool, produces no on-chain records.
- **Zero-knowledge components:** zkTLS proofs of external API calls (Trust Tier 4); zk-based proofs of code integration; TEE attestation as a complementary path.

### Parallel — Scoring Module

Separate design doc. Scoring v0.1 (basic RAID) ships with SDK v0.1; trust-tier ceilings with v1; multi-agent credit traceability with v2; economic layer (subscription, fee split, staking) with v3.

---

## 14. Open Questions

Genuinely open in the current v0.1 design:

1. **Multiple `Acting` per session.** Partial fills across venues (e.g., a bet split between Polymarket and a sibling market) legitimately need more than one terminal commitment in one decision cycle. Relax the `≤1 Acting per session` rule, or require a new session per fill?
2. **Versioning policy.** What triggers a `schema_version` bump (additive vs breaking), and how long does the server accept past versions during a migration window? Is one minor-version of overlap enough, or do we commit to a longer support tail?
3. **Sub-agent cross-reference.** Is the `tool_meta.category: "sub_agent"` convention sufficient for cross-agent traceability, or should sub-agent identity (`agent_id`, `invoked_session_id`, `referenced_record_id`) be promoted to a structured field on `BaseRecord` or `ToolCallingRecord`?
4. **`Other` promotion criteria.** When does a recurring `Other.label` value (e.g., `"file_edit"`) get promoted to a typed behavior in a future schema version? What's the cross-partner usage threshold and the proposal/review process?
5. **Server retention pre-anchoring.** With chain anchoring deferred to v1, how long does the v0.1 server retain records before some integrity backstop is required — snapshot-to-cold-storage, partner-side mirroring, periodic Merkle root export, or simply "retained indefinitely until v1"?

Deferred to v1 (non-blocking for v0.1):

- **Custodial wallet key recovery.** Wallet provisioning happens in v0.1 but no signing occurs until v1. Becomes a hard question once v1's anchoring pipeline begins signing transactions: what's the recovery story when Stair AI's KMS has an incident?
