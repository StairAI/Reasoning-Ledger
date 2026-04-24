# Reasoning Ledger SDK — Design Document

**Version:** 1  
**Date:** April 23, 2026  
**Author:** Colin Qian (CTO, Stair AI)  
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
- Record-oriented submission; idempotent via client-generated ID
- Single-record and batch endpoints
- Chain anchoring triggered server-side on `Acting` record
- Both custodial wallet (Stair AI managed) and BYOW (bring your own wallet) modes
- Trust Tier 0–2 supported

**Deferred (see Section 13):** Python / Go SDKs, field-level encryption, witness / zkTLS / TEE attestation, multi-chain adapters, Blind Sequencer, agent identity lifecycle, schema migration tooling, next-gen SDK with automated code auditing.

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
│  └─ Acting           ← anchoring triggered
│
├─ session "cycle-002"
│  ├─ Observing
│  └─ Thinking         (no Acting — not anchored, not scored)
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

| # | Behavior | Description |
|---|---|---|
| 1 | `Observing` | The triggering event |
| 2 | `ToolCalling` | Any external invocation: API, KB, model, sub-agent, on-chain read |
| 3 | `Planning` | Goal decomposition |
| 4 | `Thinking` | Analysis + option evaluation + decision (single arc) |
| 5 | `Acting` | External execution |
| 6 | `Reflecting` | Post-outcome analysis |

**Scoring eligibility:** session must contain ≥1 `Thinking` and exactly 1 `Acting` record. Others optional.

---

## 4. Record Schemas

### 4.0 Common Base

```typescript
interface BaseRecord {
  agent_id: string;
  session_id: string;
  client_record_id: string;      // SDK-generated UUID; idempotency key
  behavior: BehaviorType;
  client_ts_utc: number;         // Epoch milliseconds; client-reported timestamp for this record;
                                 // preserved across retries
  notes?: string;
  tags?: string[];
}
```

All timestamp fields in the schema use **epoch milliseconds (integer, 64-bit)** unless explicitly stated otherwise. Human-readable date strings appear only inside `description` / `*_summary` free-text fields.

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
                                             // trigger. Parallel to `goal` on Planning, `hypothesis`
                                             // on Thinking, `action_summary` on Acting. Distinct from
                                             // `notes` (optional, across-the-board escape hatch).
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
  call_id: string;               // Unique within session; referenced by Thinking
  tool_id: string;
  tool_category: ToolCategory;
  intent: string;
  input_summary: string;
  output_summary: string;
  success: boolean;
  error?: string;
  latency_ms?: number;
  data_freshness_ms?: number;
  chain_ref?: OnChainRef;        // when tool_category === "on_chain_data"
  api_ref?: ExternalApiRef;      // when tool_category === "external_api"
  kb_ref?: InternalKbRef;        // when tool_category === "internal_kb"
  function_ref?: FunctionRef;    // when tool_category in ["function","model","sub_agent"]
}

type ToolCategory =
  | "on_chain_data" | "external_api" | "internal_kb"
  | "function" | "model" | "sub_agent";

interface OnChainRef {
  network: string;
  contract_id: string;
  blob_id?: string;
  referenced_trace_record_id?: string;
  block_timestamp?: number;                  // Epoch ms
}
interface ExternalApiRef { endpoint: string; http_status?: number; }
interface InternalKbRef {
  store_type: "vector_db" | "sql" | "in_context_memory" | "file_cache";
  store_id: string;
  results_count: number;
  relevance_score?: number;
}
interface FunctionRef { function_name: string; invocation_context?: string; }
```

Cross-agent reasoning dependencies are captured automatically via `OnChainRef.referenced_trace_record_id`.

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
  inputs: ThinkingInput[];
  hypothesis: string;
  analysis: string;
  disconfirming_signals?: string[];
  alternatives: DecisionAlternative[];
  chosen_alternative_id: string;
  decision_rationale: string;
  reversibility: "irreversible" | "reversible" | "conditional";
  reversal_condition?: string;
  confidence: number;            // 0.0–1.0
  confidence_basis: string;
}

interface ThinkingInput {
  call_id?: string;              // References ToolCalling in same session
  signal_id: string;
  signal_value: string;
  weight: number;
  weight_rationale: string;
}

interface DecisionAlternative {
  alternative_id: string;
  label: string;
  expected_value: string;
  downside: string;
}
```

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
  signal_id: string;
  original_weight: number;
  retrospective_weight: number;
  note: string;
}
```

Reflecting records anchor as a separate commitment linked to the original session anchor (see Section 10).

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

| ID | Assigned by | Scope |
|---|---|---|
| `client_record_id` | SDK | Dedup key: `(agent_id, client_record_id)` |
| `record_id` | Server | Globally unique |
| `session_id` | Agent | Unique within `agent_id` |

### 5.3 Agent Identity

`agent_id` is allocated via one-time registration (see Section 6). In v1 it is a simple registered string + API key. Identity lifecycle (versions, ownership, external identity import, BYOI signing) in v2.

---

## 6. Agent Registration

### 6.1 Purpose

`agent_id` is the root index for every record an agent submits — all traces, sessions, and records are grouped under it. Registration is a one-time action that must precede any record submission.

### 6.2 What Registration Produces

| Artifact | Notes |
|---|---|
| `agent_id` | Stable string, unique per registration |
| `api_key` | Authentication secret; shown once at registration |
| Anchor wallet address | Custodial: generated by Stair AI. BYOW: provided by partner. |
| Optional metadata | Display name, description, website, tags |

### 6.3 Registration Modes

Registration happens once per agent, via either:

**(a) Control-plane HTTP endpoint** — for ops flows, dashboards, BD onboarding. Returns credentials that can be put into env vars.

**(b) SDK method** — for programmatic provisioning:

```typescript
const { agent_id, api_key, anchor_wallet_address } = await LedgerClient.register({
  name: "deep_field",                       // Partner-chosen; unique within org scope
  owner_email: "colin@stairai.com",
  wallet: { mode: "custodial" },            // or { mode: "byow", address: "0x..." }
  metadata: {
    description: "Multi-step football match predictor",
    tags: ["sports", "prediction"],
  },
});
```

After registration the partner initializes `LedgerClient` with the returned credentials as in Section 7.1.

### 6.4 Idempotency

Registration is idempotent on `(owner, name)`. Repeating the call returns the existing `agent_id` without creating a new agent. `api_key` is **not** re-disclosed on repeat calls — key rotation uses a separate endpoint.

### 6.5 Registration API

| Endpoint | Purpose |
|---|---|
| `POST /v1/agents` | Register a new agent; returns `agent_id`, `api_key`, `anchor_wallet_address` |
| `GET  /v1/agents/:agent_id` | Fetch agent metadata (public fields only) |
| `PATCH /v1/agents/:agent_id` | Update metadata (requires API key) |
| `POST /v1/agents/:agent_id/rotate-key` | Issue a new `api_key`; invalidate previous |

### 6.6 v1 Limitations

- One active `api_key` per agent
- No version management (all records submitted under same `agent_id` regardless of internal model changes)
- No ownership transfer
- No revocation beyond key rotation

Comprehensive identity management → v2.

---

## 7. SDK API Design

### 7.1 Client Initialization

```typescript
import { LedgerClient } from "@stairai/ledger-sdk";

const client = new LedgerClient({
  apiKey: process.env.STAIRAI_API_KEY,
  agentId: "deep_field_v1",
  environment: "production",
  wallet: { mode: "custodial" },  // or { mode: "byow", ... }  — see Section 11
});
```

### 7.2 Submission

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

### 7.3 Retry

In-memory only. Exponential backoff (500ms, 1s, 2s by default, configurable). Same `client_record_id` on retry → server returns original ack with `is_duplicate: true`. No persistent local sink in v1.

### 7.4 Response Shapes

```typescript
interface RecordAck {
  record_id: string;
  client_record_id: string;
  session_id: string;
  server_ts_utc: number;         // Epoch ms
  is_duplicate: boolean;
  chain_anchor_triggered: boolean;
}

interface BatchAck {
  batch_id: string;
  results: Array<RecordAck | RecordError>;
}

interface RecordError {
  client_record_id: string;
  code: string;
  message: string;
}
```

---

## 8. Trace Service API

**Control plane (agent lifecycle — see Section 6):**

| Endpoint | Purpose |
|---|---|
| `POST /v1/agents` | Register new agent; returns credentials |
| `GET  /v1/agents/:agent_id` | Fetch agent metadata |
| `PATCH /v1/agents/:agent_id` | Update metadata |
| `POST /v1/agents/:agent_id/rotate-key` | Rotate API key |

**Data plane (record submission & retrieval):**

| Endpoint | Purpose |
|---|---|
| `POST /v1/records` | Submit one record |
| `POST /v1/records:batch` | Submit ≤50 records; partial failure allowed |
| `GET  /v1/records/:id` | Fetch a record incl. chain refs |
| `GET  /v1/sessions/:id?agent_id=...` | Fetch all records in a session |
| `GET  /v1/traces/:agent_id` | Paginated trace for an agent |

Idempotency: dedup on `(agent_id, client_record_id)`. Duplicate → original ack returned.

---

## 9. Validation Rules

**Client-side (hard errors):** valid `behavior`, non-empty `session_id`, `client_ts_utc` positive integer (epoch ms), `confidence ∈ [0,1]`, `chosen_alternative_id` matches an entry, `tool_category` ↔ `*_ref` consistency, `Acting.execution_id` present when target is public-chain + confirmed.

**Server-side:** API key ↔ `agent_id` match, `(agent_id, client_record_id)` unique, ≤1 `Acting` per session, `server_ts_utc` and `record_id` server-assigned, batch ≤50.

**Intentional non-rules:** no "first record must be Observing," no session lifecycle, no session timeout.

---

## 10. Trace Service Architecture

```
Agent ──HTTP──▶ Trace Service ──▶ Walrus DA (blob)
                              └─▶ SUI Trace Ledger (anchor)
```

**On `POST /v1/records`:**
1. Auth & validate
2. Dedup check (return original if match)
3. Assign `record_id`, stamp `server_ts_utc`, persist
4. Return ack immediately
5. Background: trigger anchoring (if `Acting`) or reflection anchor (if `Reflecting`); enqueue for Trust Tier 2

**Anchoring on `Acting`:** collect session records with `server_ts_utc ≤ Acting.server_ts_utc` → compute Merkle root → upload bundle to Walrus → submit `(agent_id, session_id, merkle_root, blob_id)` to SUI. Post-anchor records (except `Reflecting`) are stored with `post_anchor: true`, excluded from the Merkle tree.

**Reflecting** anchors as a separate, linked commitment.

---

## 11. Wallet Integration

### 11.1 Two Modes

Partners choose one mode at client initialization:

| Mode | Wallet ownership | Signing | Gas |
|---|---|---|---|
| **Custodial** (default) | Stair AI creates and holds a SUI wallet for the agent | Stair AI signs anchor txs | Stair AI pays |
| **BYOW** (bring your own wallet) | Partner owns the SUI wallet | Partner signs via SDK hook; Stair AI service submits | Partner pays |

Both modes produce identical trace records and anchors on-chain. The difference is only in *who owns the key that signs the anchor*.

### 11.2 Custodial Mode (Zero Web3 Experience Required)

```typescript
const client = new LedgerClient({
  apiKey: process.env.STAIRAI_API_KEY,
  agentId: "deep_field_v1",
  wallet: { mode: "custodial" },
});
```

- Stair AI provisions a SUI wallet per `agent_id` on first use
- Wallet key is held in Stair AI's KMS (HSM-backed)
- All anchor txs signed and submitted by Stair AI
- Partner has no on-chain exposure and no gas management

### 11.3 BYOW Mode

```typescript
const client = new LedgerClient({
  apiKey: process.env.STAIRAI_API_KEY,
  agentId: "deep_field_v1",
  wallet: {
    mode: "byow",
    address: "0xPARTNER_SUI_ADDRESS",
    signer: async (txBytes) => partnerSigner.sign(txBytes),  // partner-provided
  },
});
```

- Partner provides their SUI address and a signing callback
- When the server is ready to anchor, it prepares the tx bytes and returns them to the SDK via a pending-signature channel
- SDK invokes `signer(txBytes)` and returns the signature
- Server submits the signed tx to SUI; partner's address is recorded as the anchor author

### 11.4 Server-Side Responsibilities

In both modes the Trace Service:
- Builds the anchor tx (Merkle root + Walrus blob ID + metadata)
- Submits to SUI after signing
- Records `anchor_author_address` with each session anchor

The `anchor_author_address` is surfaced in `GET /v1/sessions/:id` so consumers can distinguish custodial anchors (Stair AI signer) from partner-signed anchors.

### 11.5 Migration Path

A partner can switch from custodial to BYOW for future sessions. Historical sessions remain anchored under whichever mode was active at the time. There is no re-anchoring of historical sessions in v1.

### 11.6 Out of Scope for v1

- Partner-signing at the **record** level (currently only anchor-level; records themselves are unsigned). Record-level BYOI signing → v2.
- Wallet recovery / key rotation for custodial wallets. KMS-level recovery only in v1.
- Multi-sig anchor authorization.

---

## 12. Trust & Attestation

### 12.1 Tiers

| Tier | Name | Verification | v1 |
|---|---|---|---|
| 0 | Self-Report | Server timestamps only | ✅ |
| 1 | Oracle-Verified Acting | On-chain tx reconciles with `Acting` record | ✅ |
| 2 | Behavioral Consistency | Server-side statistical analysis passes | ✅ |
| 3 | Witness-Attested | Signed responses from tool providers | v2 |
| 4 | zkTLS-Verified | Cryptographic proofs of external calls | v3 |
| 5 | TEE-Attested | Trusted runtime attestation | v1.0 |

### 12.2 v1 Tiers in Detail

**Tier 0 (baseline).** Every session starts here. Trust rests on `server_ts_utc` stamped before external action completes + commercial agreements.

**Tier 1.** When `Acting.target_system` is a public-chain system and `execution_id` is provided, an Oracle pipeline fetches the tx on-chain and verifies: parameters match the record, tx timestamp is after `Acting.server_ts_utc`. Launch targets: Polymarket, Uniswap, SUI DEXs.

**Tier 2.** Server-side analysis flags anomalies across dimensions: `latency_ms` vs realistic distribution, `data_freshness_ms` vs tool refresh cadence, cross-agent consistency, self-consistency drift, score–outcome correlation. Runs async; does not block submission. Specific thresholds are not public (to prevent adversarial optimization).

### 12.3 Tier Re-evaluation

Tier is always the current evaluation — not path-dependent. When new attestations become available or detection rules change, all historical sessions are re-evaluated. No formal demotion / dispute flow needed.

### 12.4 Score × Tier

Tier caps the Stair AI Score a session can receive. Exact ceilings are defined in the separate Scoring Module design.

### 12.5 Wallet Mode vs Trust Tier

Wallet mode (custodial vs BYOW) is **orthogonal** to Trust Tier. BYOW does not automatically increase Trust Tier in v1 — anchor authorship and record authenticity are separate questions. In v2, record-level BYOI signing will contribute to a higher Tier.

---

## 13. Roadmap

### v1 — Foundation (Q2 2026)

Record / session / trace model · 6 behaviors · TS SDK · single + batch submission · in-memory retry · custodial + BYOW wallets · Trust Tier 0–2 · Arena 5 agents migrated · 2–3 commercial partners · Champions League dry run May 31.

### v2 — Ecosystem Expansion (Q3 2026)

Python SDK · field-level encryption & privacy control · BYOI record signing · agent identity solution (versions, ownership, external identity import) · schema versioning & migration tooling · Trust Tier 3 (witness signatures) · on-chain `tool_id` registry.

### v3 — Cryptographic Trust (Q4 2026)

Go SDK · Trust Tier 4 (zkTLS) · multi-chain adapter (Celestia / EigenDA / ETH L2 / Solana) · Blind Sequencer · first breaking-change migration drill.

### v1.0 — Institutional Grade (Q1 2027)

Trust Tier 5 (TEE) · next-gen SDK with automated code-integration audit (committed audit, not zk) · schema v1.0 freeze · use-case-specific frameworks · backtest framework (independent tool, no trace output).

### Long-term R&D (2027+)

zk-based code integration proof · multi-agent composition primitives · cross-protocol trust interop · decentralized Trace Service.

### Parallel — Scoring Module

Separate design doc. Scoring v1 (basic RAID) with SDK v1; trust-tier ceilings with v2; multi-agent credit traceability with v3; economic layer (subscription, fee split, staking) with v1.0.

---

## 14. Open Questions

1. **On-chain data privilege:** does `tool_category: "on_chain_data"` get a score boost, or is weight purely agent-declared?
2. **Multiple `Acting` per session:** partial fills across venues legitimately need this; relax the constraint?
3. **Batch size:** 50 sufficient?
4. **Rate limits:** per-agent ceilings for `/records` and `/records:batch`?
5. **Tier 1 Oracle coverage:** priority list beyond Polymarket / Uniswap / SUI DEX?
6. **Witness-partner BD timing:** which tool providers first? When to start BD for v2 Q3 2026 delivery?
7. **Custodial wallet key recovery:** what's the recovery story if Stair AI KMS has an incident?
