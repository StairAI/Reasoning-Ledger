# Record Schema Reference

Field-level reference for every record type in the Reasoning Ledger.

The single source of truth is [`records.schema.json`](./records.schema.json) (JSON Schema Draft 2020-12). This document is hand-maintained prose **about** that schema — when the two disagree, the JSON Schema wins. Past versions are snapshotted under [`history/`](./history/).

- **Current schema version:** `0.3`
- **Accepted on the wire:** `0.1`, `0.2`, `0.3` (the live schema plus every `history/` snapshot, so old SDK clients keep working during migrations)

Every record is a discriminated union member keyed on `behavior`. A record consists of the shared **BaseRecord** fields plus the fields specific to its behavior. Each behavior closes its object (`unevaluatedProperties: false`) — unknown top-level fields are rejected.

---

## Shared fields — `BaseRecord`

Present on every record regardless of behavior.

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | ✅ | Schema version the record was stamped with (e.g. `"0.3"`). SDKs set this automatically from the bundled `SCHEMA_VERSION`. |
| `agent_id` | UUID v4 | ✅ | The agent that produced the record. |
| `session_id` | string | ✅ | Group key clustering records of one decision cycle. Not a lifecycle entity — records simply share the string. |
| `record_id` | UUID v4 | ✅ | Unique id for this record. |
| `behavior` | enum | ✅ | One of `Observing`, `ToolCalling`, `Planning`, `Thinking`, `Acting`, `Reflecting`, `Other`. Discriminates the union. |
| `client_ts_utc` | epoch ms | ✅ | Client-side creation time, integer milliseconds since the Unix epoch. |
| `notes` | string (≤2048) | | Free-form human-readable annotation. |
| `tags` | string[] (≤32 items, ≤64 chars each) | | Arbitrary labels for filtering/grouping. |
| `model_invocation` | `ModelInvocation` | | Details of the foundation-model call behind this record (see below). |
| `upstream_record_id` | UUID v4[] (≤32) | | DAG dependency / trace sequence — records this one builds on. May be empty or omitted. |
| `parent_record_id` | UUID v4 | | Sub-thread containment. Set when this record is produced inside a sub-thread spawned by another record. For ordinary DAG dependencies use `upstream_record_id` instead. |

### `upstream_record_id` vs `parent_record_id`

- **`upstream_record_id`** — "this builds on those." Ordinary data/decision dependencies within the same thread.
- **`parent_record_id`** — "this lives inside that." Containment for records produced within a spawned sub-thread. Records outside the sub-thread do **not** list internal sub-thread records as upstream.

---

## `ModelInvocation` (sub-object)

Optional object on any record, describing the foundation-model call that produced it. Closed object — only the fields below are allowed.

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string (≥1) | ✅ | Model provider, e.g. `"openai"`, `"anthropic"`, `"deepseek"`. |
| `model_name` | string (≥1) | ✅ | Model identifier, e.g. `"gpt-4o"`, `"claude-opus-4-8"`. |
| `model_version` | string | | Provider-specific version/snapshot id. |
| `tokens_in` | integer (≥0) | | Prompt/input token count. |
| `tokens_out` | integer (≥0) | | Completion/output token count. |
| `cost_usd` | number (≥0) | | Billed cost of the call in USD. |
| `temperature` | number | | Sampling temperature used. |
| `finish_reason` | string | | Provider's stop reason, e.g. `"stop"`, `"length"`, `"tool_calls"`. |
| `internal_reasoning` | string | | Raw internal reasoning / chain-of-thought emitted by the model **alongside and distinct from its final output**. See note below. |

### `internal_reasoning`

Modern foundation models expose an internal reasoning channel separate from the visible answer. This field captures that raw reasoning trace as the provider returned it:

| Provider | Source channel |
|---|---|
| DeepSeek / vLLM / OpenRouter | `reasoning_content` |
| OpenAI (o-series) | reasoning tokens / reasoning summary |
| Anthropic | extended-thinking (`thinking`) blocks |
| Gemini | thoughts / thinking |

> **Not the same as the `Thinking` behavior.** `internal_reasoning` is the *model's* own chain-of-thought attached to a single invocation, and can appear on **any** record that carries a `model_invocation` (e.g. a `ToolCalling` or `Acting` record). The `Thinking` behavior, by contrast, records a *deliberate agent thinking step* the SDK caller chose to log, with its own `prompt`/`inputs`/`output_payload`. A record can have both.

---

## Behavior records

Each section lists only the fields **added on top of** `BaseRecord`.

### `Observing` — the triggering event that woke the agent

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Observing"` | ✅ | Discriminator constant. |
| `trigger_source` | string (≥1) | ✅ | Where the trigger came from (queue, webhook, scheduler, …). |
| `trigger_type` | enum | ✅ | `"signal_trigger"` (event-driven) or `"cron_trigger"` (scheduled). |
| `trigger_description` | string (≥1) | ✅ | Human-readable description of the trigger. |
| `trigger_payload_summary` | string (≤4096) | ✅ | Summary of the trigger payload. |
| `external_trigger_id` | string | | Correlation id from the upstream system. |
| `event_ts_utc` | epoch ms | | When the triggering event occurred (may precede `client_ts_utc`). |

### `ToolCalling` — any external call

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"ToolCalling"` | ✅ | Discriminator constant. |
| `tool_meta` | object (open) | ✅ | Arbitrary metadata about the tool (name, version, endpoint, …). |
| `description` | string (≥1) | ✅ | What the call was for. |
| `input_payload` | any | ✅ | The input sent to the tool (any JSON value). |
| `output_payload` | any | ✅ | The result returned by the tool (any JSON value). |
| `success` | boolean | ✅ | Whether the call succeeded. |

### `Planning` — goal decomposition into steps

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Planning"` | ✅ | Discriminator constant. |
| `goal` | string (≥1) | ✅ | The objective being planned toward. |
| `steps` | `PlanningStep`[] | ✅ | Ordered steps (see below). |
| `contingencies` | string[] | | Fallback / alternative considerations. |

**`PlanningStep`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `index` | integer (≥0) | ✅ | Position of the step. |
| `description` | string (≥1) | ✅ | What the step does. |
| `depends_on` | integer[] (≥0) | | Indices of steps this one depends on. |

### `Thinking` — analysis, option evaluation, decision

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Thinking"` | ✅ | Discriminator constant. |
| `prompt` | string (≥1) | ✅ | The question/instruction driving this thinking step. |
| `inputs` | `ThinkingInput`[] | ✅ | Inputs considered (see below). |
| `output_payload` | string (≥1) | ✅ | The conclusion/output of the step. |

**`ThinkingInput`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `input_payload` | string | ✅ | The input content. |
| `input_record_id` | UUID v4 | | Reference to a prior record this input came from. |

### `Acting` — the terminal commitment that resolves the cycle

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Acting"` | ✅ | Discriminator constant. |
| `action_type` | string (≥1) | ✅ | Class of action (e.g. `"transfer"`, `"publish"`). |
| `target_system` | string (≥1) | ✅ | System being acted upon (e.g. `"public-chain"`). |
| `action_summary` | string (≥1) | ✅ | Human-readable summary of the action. |
| `parameters` | object (open) | ✅ | Action parameters. |
| `dry_run` | boolean | ✅ | Whether this was a simulation rather than a real action. |
| `execution_status` | enum | ✅ | `"confirmed"`, `"failed"`, `"simulated"`, or `"pending"`. |
| `execution_id` | string | conditional | External execution id (e.g. tx hash). **Required** when `target_system` is `"public-chain"` and `execution_status` is `"confirmed"`. |

### `Reflecting` — post-hoc reasoning over prior behavior

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Reflecting"` | ✅ | Discriminator constant. |
| `inputs` | `ReflectingInput`[] | ✅ | Prior material being reflected on (same shape as `ThinkingInput`). |
| `output_payload` | string (≥1) | ✅ | The reflection's conclusion. |

**`ReflectingInput`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `input_payload` | string | ✅ | The input content. |
| `input_record_id` | UUID v4 | | Reference to a prior record this input came from. |

### `Other` — catch-all for behaviors outside the taxonomy

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Other"` | ✅ | Discriminator constant. |
| `label` | string (≥1) | ✅ | Short label naming the behavior. |
| `data` | object (open) | ✅ | Arbitrary structured payload. |

---

## Shared scalar types

| Name | Definition |
|---|---|
| `UuidV4` | string, `format: uuid` |
| `EpochMs` | integer ≥ 0 — milliseconds since the Unix epoch |
| `BehaviorType` | enum: `Observing`, `ToolCalling`, `Planning`, `Thinking`, `Acting`, `Reflecting`, `Other` |

---

## Client-side size limits

Beyond the JSON Schema constraints, the SDKs enforce byte/size limits before any network call (see `SIZE_LIMITS` in each SDK). Notable ones: per-record JSON ≤ 64 KB, per-batch JSON ≤ 1 MB, `Thinking.prompt` ≤ 16 KB, `Thinking.output_payload` ≤ 32 KB, `ToolCalling` payloads ≤ 16/32 KB, `Acting.parameters` and `Other.data` ≤ 16 KB.

---

## Changelog

| Version | Change |
|---|---|
| `0.3` | Added `ModelInvocation.internal_reasoning` — captures the model's raw chain-of-thought, distinct from its final output. |
| `0.2` | (snapshot in [`history/0.2/`](./history/0.2/)) |
| `0.1` | (snapshot in [`history/0.1/`](./history/0.1/)) |
