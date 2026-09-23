# Record Schema Reference

Field-level reference for every record type in the Reasoning Ledger.

The single source of truth is [`records.schema.json`](./records.schema.json) (JSON Schema Draft 2020-12). This document is hand-maintained prose **about** that schema — when the two disagree, the JSON Schema wins. Past versions are snapshotted under [`history/`](./history/).

- **Current schema version:** `0.4`
- **Accepted for writes:** `0.4` only. A write stamped with any other version is rejected, and the error says why.
- **Readable:** every version. Records written as `0.1`–`0.3` keep their original shape and version stamp.
- **Retired label:** `1.0`. SDK 0.1.0 stamped the format now called `0.2` as `"1.0"`; stored records carrying it were relabelled `0.2`, and the label is never reused. A write stamped `"1.0"` is rejected with a message to upgrade the SDK.

The schema version is numbered separately from the SDK and server versions: SDK and server 1.0.0 write schema `0.4`.

Every record is a discriminated union member keyed on `behavior`. A record consists of the shared **BaseRecord** fields plus the fields specific to its behavior. Each behavior closes its object (`unevaluatedProperties: false`) — unknown top-level fields are rejected.

---

## Content references — `ContentRef`

Raw text never goes into a record. Prompts, model outputs, tool inputs and outputs, and reasoning traces are uploaded to the server's content library first, and the record holds a reference to them:

| Field | Type | Required | Description |
|---|---|---|---|
| `sha256` | `Sha256Hex` | ✅ | SHA-256 of the raw bytes, lowercase hex. Also the content's address: `PUT` / `GET /v1/content/{sha256}`. |
| `bytes` | integer (≥0) | ✅ | Size of the raw bytes. |
| `media_type` | string (≥1) | ✅ | e.g. `"text/plain; charset=utf-8"`, `"application/json"`. |

The object is closed: exactly these three keys. When a record is submitted, the server checks that every referenced object was uploaded by the same owner, has not been deleted, and has the declared size; otherwise the record is rejected. The SDKs upload raw values for you: in a content position you may pass a string, bytes or any other JSON value instead of a `ContentRef` (see the SDK READMEs).

Content positions: `ToolCalling.input_payload` and `.output_payload`; `Thinking.prompt`, `.output_payload` and `.inputs[].input_payload`; `Reflecting.output_payload` and `.inputs[].input_payload`; `ModelInvocation.internal_reasoning`; `Attesting.effects`. `Attesting.evidence_refs` items may be record ids or `ContentRef`s.

Stored content can be deleted by the server's operator (not through the API). Records are never changed: their hashes still show that the content existed, and reading the content afterwards answers `410 Gone`.

---

## Shared fields — `BaseRecord`

Present on every record regardless of behavior.

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | ✅ | Schema version the record was stamped with (e.g. `"0.4"`). SDKs set this automatically from the bundled `SCHEMA_VERSION`. |
| `agent_id` | UUID v4 | ✅ | The agent that produced the record. |
| `session_id` | string | ✅ | Group key clustering records of one decision cycle. Not a lifecycle entity — records simply share the string. |
| `record_id` | UUID v4 | ✅ | Unique id for this record. |
| `behavior` | enum | ✅ | One of `Observing`, `ToolCalling`, `Planning`, `Thinking`, `Acting`, `Reflecting`, `Attesting`, `Other`. Discriminates the union. |
| `client_ts_utc` | epoch ms | ✅ | Client-side creation time, integer milliseconds since the Unix epoch. |
| `executor` | enum | ✅ | Who performed the step: `"ai"` (a model), `"det"` (deterministic code) or `"human"` (a person). |
| `record_phase` | enum | ✅ | When the record was written relative to the step it describes: `"pre_execution"`, `"concurrent"` or `"post_execution"`. |
| `outcome` | enum | | Result of the step: `"success"`, `"failure"`, `"denied"`, `"escalated"` or `"timeout"`. Required on `ToolCalling`. |
| `duration_ms` | integer (≥0) | | How long the step took. |
| `sources` | `SourceDescriptor`[] (≤64) | | Where the step's inputs came from (see below). |
| `verdict` | `Verdict` | | The basis of a judgment made in this step (see below). |
| `notes` | string (≤2048) | | Free-form human-readable annotation. |
| `tags` | string[] (≤32 items, ≤64 chars each) | | Arbitrary labels for filtering/grouping. |
| `model_invocation` | `ModelInvocation` | | Details of the foundation-model call behind this record (see below). |
| `upstream_record_id` | UUID v4[] (≤32) | | DAG dependency / trace sequence — records this one builds on. May be empty or omitted. |
| `parent_record_id` | UUID v4 | | Sub-thread containment. Set when this record is produced inside a sub-thread spawned by another record. For ordinary DAG dependencies use `upstream_record_id` instead. |

### Fields added by the server

Records read back from the server also carry `server_ts_utc` (epoch ms, when the server received the record) and `sequence` (integer, a total order over all records assigned by the server on receipt; later records have larger numbers). Clients never send them.

### `SourceDescriptor`

Open object: only `kind` and `ref` are required, other fields are allowed.

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | string (≥1) | ✅ | Kind of source, e.g. `"model"`, `"rule"`, `"reference_data"`, `"api"`, `"document"`, `"human"`. |
| `ref` | string (≥1) | ✅ | Stable reference to the source. |
| `fetched_at` | epoch ms | | When it was fetched. |
| `sha256` | `Sha256Hex` | | Content hash of what was fetched. |
| `record_id` | UUID v4 | | The record that fetched it. |

### `Verdict`

Open object: only `conclusion` and `decided_by` are required, other fields are allowed.

| Field | Type | Required | Description |
|---|---|---|---|
| `conclusion` | any | ✅ | The judgment itself (any JSON value). |
| `decided_by` | string (≥1) | ✅ | Who or what made the judgment. |
| `signals` | object[] | | Signals the judgment weighed. |
| `rule_ref` | string[] | | Rules applied. |
| `confidence` | number 0–1 or null | | Confidence, when one exists. |
| `sources` | `SourceDescriptor`[] | | Sources the judgment relied on. |
| `counterfactual` | string | | What would have changed the judgment. |
| `dissent` | object[] | | Disagreeing opinions. |

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
| `internal_reasoning` | `ContentRef` | | Raw internal reasoning / chain-of-thought emitted by the model **alongside and distinct from its final output**, stored in the content library. See note below. |

### `internal_reasoning`

Modern foundation models expose an internal reasoning channel separate from the visible answer. This field references that raw reasoning trace as the provider returned it:

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
| `input_payload` | `ContentRef` | ✅ | The input sent to the tool. |
| `output_payload` | `ContentRef` | ✅ | The result returned by the tool. |
| `outcome` | `Outcome` | ✅ | Result of the call. Replaces the `0.3` boolean `success`. |

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
| `prompt` | `ContentRef` | ✅ | The question/instruction driving this thinking step. |
| `inputs` | `ThinkingInput`[] | ✅ | Inputs considered (see below). |
| `output_payload` | `ContentRef` | ✅ | The conclusion/output of the step. |

**`ThinkingInput`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `input_payload` | `ContentRef` | ✅ | The input content. |
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
| `output_payload` | `ContentRef` | ✅ | The reflection's conclusion. |

**`ReflectingInput`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `input_payload` | `ContentRef` | ✅ | The input content. |
| `input_record_id` | UUID v4 | | Reference to a prior record this input came from. |

### `Attesting` — a person's disposition of a pending action

Submitted by the application on the person's behalf, not by the agent's own instrumentation; the SDKs have a separate entry point for it (`submitAttesting` / `submit_attesting`).

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Attesting"` | ✅ | Discriminator constant. |
| `executor` | `"human"` | ✅ | Always `"human"`. |
| `operator_id` | string (≥1) | ✅ | The person who made the disposition. |
| `disposition` | enum | ✅ | `"approve"`, `"reject"` or `"edit"`. For decisions that choose a value: `approve` accepted the suggested value, `edit` changed it. |
| `gate_kind` | string (≥1) | ✅ | Kind of checkpoint, defined by the application. |
| `written_by` | `WrittenBy` | ✅ | Which component wrote the record, with which credential (see below). |
| `decision` | any | | Structured decision content: the value the person chose or entered. Its shape is defined by the application. |
| `reason` | string (≥1) | conditional | **Required** when `disposition` is `"reject"`. |
| `patch` | object (open) | | Changes to the original parameters when `disposition` is `"edit"`. |
| `evidence_refs` | (UUID v4 \| `ContentRef`)[] (≤64) | | Records or content the disposition relied on. |
| `seen_digest` | string (≥1) | | Digest of what the person saw when deciding. |
| `policy_snapshot` | object (open) | | Policy in force at the time, or a content reference to it. |
| `effects` | `ContentRef` | | Side effects of the disposition in the application, e.g. configuration or rule changes. |

**`WrittenBy`** — closed object, both fields required: `component` (string ≥1) and `credential` (string ≥1).

`written_by` is declared by the submitter: it is a record, not a permission. The ledger does not run the action, so a forged `Attesting` record makes nothing happen, but the ledger cannot stop a program holding a valid API key from writing any `written_by`. An `Attesting` record shows that the log recorded a person's check; it does not prove that a person checked.

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
| `BehaviorType` | enum: `Observing`, `ToolCalling`, `Planning`, `Thinking`, `Acting`, `Reflecting`, `Attesting`, `Other` |
| `Sha256Hex` | string of 64 lowercase hex characters |
| `Executor` | enum: `ai`, `det`, `human` |
| `RecordPhase` | enum: `pre_execution`, `concurrent`, `post_execution` |
| `Outcome` | enum: `success`, `failure`, `denied`, `escalated`, `timeout` |

---

## Cross-field rules

Two rules depend on more than one field. The JSON Schema expresses them with `if`/`then`; the server and both SDKs enforce them:

- `Acting` with `target_system` `"public-chain"` and `execution_status` `"confirmed"` requires `execution_id`.
- `Attesting` with `disposition` `"reject"` requires `reason`.

---

## Size limits

Beyond the JSON Schema constraints, the SDKs enforce size limits before any network call (see `SIZE_LIMITS` in each SDK), and the server enforces the record and batch limits again: per-record JSON ≤ 64 KB, per-batch JSON ≤ 1 MB (and ≤ 50 records), `Acting.parameters` and `Other.data` ≤ 16 KB. Content is not part of the record: the server limits each uploaded object (64 MiB by default, set by its operator).

---

## Changelog

| Version | Change |
|---|---|
| `0.4` | Raw content moves out of records into the content library (`ContentRef` at every content position). New required base fields `executor` and `record_phase`; new optional base fields `outcome`, `duration_ms`, `sources`, `verdict`. `ToolCalling.success` replaced by the required `outcome`. New behavior `Attesting`. Writes accept `0.4` only; the label `1.0` is retired. Previous schema in [`history/0.3/`](./history/0.3/). |
| `0.3` | Added `ModelInvocation.internal_reasoning` — captures the model's raw chain-of-thought, distinct from its final output. |
| `0.2` | (snapshot in [`history/0.2/`](./history/0.2/)) |
| `0.1` | (snapshot in [`history/0.1/`](./history/0.1/)) |
