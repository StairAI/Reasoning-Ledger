# Record Schema Reference

Field-level reference for every record type in the Reasoning Ledger.

The single source of truth is [`records.schema.json`](./records.schema.json) (JSON Schema Draft 2020-12). This document is hand-maintained prose **about** that schema — when the two disagree, the JSON Schema wins. Past versions are snapshotted under [`history/`](./history/).

- **Current schema version:** `0.5`
- **Accepted for writes:** `0.5` only. A write stamped with any other version is rejected, and the error says why.
- **Readable:** every version. Records written as `0.1`–`0.4` keep their original shape and version stamp; a `0.4` record may still carry the behavior `Planning` and the fields `0.5` removed.
- **Retired label:** `1.0`. SDK 0.1.0 stamped the format now called `0.2` as `"1.0"`; stored records carrying it were relabelled `0.2`, and the label is never reused. A write stamped `"1.0"` is rejected with a message to upgrade the SDK.

The schema version is numbered separately from the SDK and server versions.

Every record is a discriminated union member keyed on `behavior`. A record consists of the shared **BaseRecord** fields plus the fields specific to its behavior. Each behavior closes its object (`unevaluatedProperties: false`) — unknown top-level fields are rejected.

## Requirement levels

Fields come in three levels, after the OpenTelemetry convention:

- **Required** — the schema rejects a record without it.
- **Recommended** — accepted when absent, but counted: the server computes each record's *completeness* (the share of its applicable recommended fields that are filled) and reports it per session, agent and writer through the administrator's read endpoints. Marked **◐** in the tables below.
- **Optional** — everything else.

Recommended fields: `classification`, `written_by` (required on `Attesting`), `outcome` where it is not required, `duration_ms`, `error_type` when the outcome is not `success`, `tool_meta.call_id` and `tool_meta.tool_type`, `model_invocation.invocation_kind` and its token counts, `verdict` on `Thinking`, `Reflecting` and ai-executed `Acting`, `Attesting.channel`, `Attesting.seen_completeness`, `Attesting.policy_snapshot`, and `sources` on `Observing`.

---

## Content references — `ContentRef`

Raw text never goes into a record. Prompts, model outputs, tool inputs and outputs, reasoning traces, questions put to a person and goals handed to another agent are uploaded to the server's content library first, and the record holds a reference to them:

| Field | Type | Required | Description |
|---|---|---|---|
| `sha256` | `Sha256Hex` | ✅ | SHA-256 of the raw bytes, lowercase hex. Also the content's address: `PUT` / `GET /v1/content/{sha256}`. |
| `bytes` | integer (≥0) | ✅ | Size of the raw bytes. |
| `media_type` | string (≥1) | ✅ | e.g. `"text/plain; charset=utf-8"`, `"application/json"`. |

The object is closed: exactly these three keys. When a record is submitted, the server checks that every referenced object was uploaded by the same owner, has not been deleted, and has the declared size; otherwise the record is rejected. The SDKs upload raw values for you: in a content position you may pass a string, bytes or any other JSON value instead of a `ContentRef` (see the SDK READMEs).

Content positions: `ToolCalling.input_payload` and `.output_payload`; `Thinking.prompt`, `.output_payload` and `.inputs[].input_payload`; `Reflecting.output_payload` and `.inputs[].input_payload`; `Escalating.asked`; `Delegating.goal` and `.result`; `Memorizing.target`; `Attesting.effects`; `ModelInvocation.internal_reasoning`; `ModelInvocation.replay_of` when it is a `ContentRef` rather than a record id.

Stored content can be deleted by the server's operator (not through the API). Records are never changed: their hashes still show that the content existed, and reading the content afterwards answers `410 Gone`.

---

## Shared fields — `BaseRecord`

Present on every record regardless of behavior.

| Field | Type | Required | Description |
|---|---|---|---|
| `schema_version` | string | ✅ | Schema version the record was stamped with (e.g. `"0.5"`). SDKs set this automatically from the bundled `SCHEMA_VERSION`. |
| `agent_id` | UUID v4 | ✅ | The agent whose behavior this is. |
| `session_id` | string | ✅ | Group key clustering records of one decision cycle (see [Sessions](#sessions-and-cycles)). Not a lifecycle entity — records simply share the string. |
| `record_id` | UUID v4 | ✅ | Unique id for this record. |
| `behavior` | enum | ✅ | One of `Observing`, `ToolCalling`, `Thinking`, `Acting`, `Reflecting`, `Attesting`, `Escalating`, `Delegating`, `Memorizing`, `Other`. Discriminates the union. |
| `client_ts_utc` | epoch ms | ✅ | Client-side creation time, integer milliseconds since the Unix epoch. |
| `executor` | enum | ✅ | Who performed the step: `"ai"` (a model), `"det"` (deterministic code) or `"human"` (a person). |
| `record_phase` | enum | ✅ | When the record was written relative to the step it describes: `"pre_execution"`, `"concurrent"` or `"post_execution"`. |
| `outcome` | enum | ✅ on `ToolCalling`, `Acting`, `Attesting`, `Escalating`, `Delegating`, `Memorizing`; ◐ elsewhere | Result of the step: `"success"`, `"failure"`, `"denied"`, `"escalated"`, `"timeout"` or `"cancelled"`. |
| `duration_ms` | integer (≥0) | ◐ | How long the step took. On `Attesting` and `Escalating`: how long the pending item waited for a person. |
| `error_type` | string (≤128) | ◐ when `outcome` is not `success` | Low-cardinality error class, e.g. `"tool.not_found"`, `"permission.denied"`, `"http.5xx"`, `"validation.rejected"`, `"user.abort"`. |
| `written_by` | `WrittenBy` | ◐ (✅ on `Attesting`) | Which program wrote the record, with which credential (see below). |
| `on_behalf_of_agent_id` | UUID v4 | | Set when the writer is not the agent whose behavior this is — a platform recording a fill or a settlement for an agent, a parent harness writing for a sub-agent. |
| `classification` | `Classification` | ◐ | How the record came to carry its behavior (see below). |
| `sources` | `SourceDescriptor`[] (≤64) | ◐ on `Observing` | Where the step's inputs came from (see below). |
| `verdict` | `Verdict` | ◐ on `Thinking`, `Reflecting`, ai-executed `Acting` | The basis of a judgment made in this step (see below). |
| `notes` | string (≤2048) | | Free-form human-readable annotation. |
| `tags` | string[] (≤32 items, ≤64 chars each) | | Arbitrary labels for filtering/grouping. |
| `model_invocation` | `ModelInvocation` | | Details of the foundation-model call behind this record (see below). |
| `upstream_record_id` | UUID v4[] (≤32) | | DAG dependency / trace sequence — records this one builds on. May be empty or omitted. An `Attesting` record lists here the `Escalating` record it answers. |

`parent_record_id` (sub-thread containment in 0.4) is gone: a sub-agent's records live in their own session, linked from the parent's `Delegating.child_session_id`; ordinary dependencies use `upstream_record_id`.

### Fields added by the server

Records read back from the server also carry `server_ts_utc` (epoch ms, when the server received the record) and `sequence` (integer, a total order over all records assigned by the server on receipt; later records have larger numbers). Clients never send them.

### `WrittenBy`

Closed object, both fields required: `component` (string ≥1) and `credential` (string ≥1).

`written_by` is declared by the submitter: it is a record, not a permission. The ledger does not run the action, so a forged `Attesting` record makes nothing happen, but the ledger cannot stop a program holding a valid API key from writing any `written_by`. An `Attesting` record shows that the log recorded a person's check; it does not prove that a person checked.

### `Classification`

Closed object.

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | enum | ✅ | `"instrumented"` (the writer knew the behavior when it wrote the record), `"rule"` (inferred from a raw trace by a deterministic rule), `"judge"` (labelled by a model) or `"human"` (labelled by a person). |
| `mapper` | string (≥1) | | Name and version of the writer or mapper, e.g. `"collector@0.3"`. |
| `confidence` | number 0–1 | | How sure the mapper was. |
| `alternatives` | `{behavior, confidence}`[] (≤8) | | Other behaviors the mapper considered. |

### `SourceDescriptor`

Open object: only `kind` and `ref` are required, other fields are allowed.

| Field | Type | Required | Description |
|---|---|---|---|
| `kind` | string (≥1) | ✅ | Kind of source, e.g. `"model"`, `"rule"`, `"reference_data"`, `"api"`, `"document"`, `"human"`, `"record"`. |
| `ref` | string (≥1) | ✅ | Stable reference to the source. For `"record"`, a record id. |
| `fetched_at` | epoch ms | | When it was fetched. |
| `sha256` | `Sha256Hex` | | Content hash of what was fetched. |

### `Verdict`

Open object: only `conclusion` and `decided_by` are required, other fields are allowed.

| Field | Type | Required | Description |
|---|---|---|---|
| `conclusion` | any | ✅ | The judgment itself (any JSON value). |
| `decided_by` | enum | ✅ | Who or what made the judgment: `"human"`, `"model"`, `"rule"`, `"policy"`, `"classifier"`, `"config"` or `"consensus"`. A machine approval (a policy, a configured rule, a classifier letting an action through) is recorded here, on the record it decided, never as an `Attesting` record. |
| `signals` | object[] | | Signals the judgment weighed. |
| `rule_ref` | string[] | | Rules applied. |
| `confidence` | number 0–1 or null | | Confidence, when one exists. |

---

## `ModelInvocation` (sub-object)

Optional object on any record, describing the foundation-model call that produced it. Closed object — only the fields below are allowed.

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string (≥1) or null | ✅ | Model provider, e.g. `"openai"`, `"anthropic"`, `"deepseek"`. Null only when `invocation_kind` is `"replay"` or `"simulated"`. |
| `model_name` | string (≥1) or null | ✅ | Model identifier, e.g. `"gpt-4o"`, `"claude-opus-4-8"`. Null only when `invocation_kind` is `"replay"` or `"simulated"`. |
| `invocation_kind` | enum | ◐ | `"live"` (a real call), `"replay"` (a recorded response played back), `"cached"` (served from a cache) or `"simulated"` (produced without a model). Replays and simulations are not model calls: leave them out of cost and usage statistics. |
| `replay_of` | UUID v4 or `ContentRef` | | The record or content a replay reproduces. |
| `tokens_in` | integer (≥0) | ◐ | Prompt/input token count. |
| `tokens_out` | integer (≥0) | ◐ | Completion/output token count. |
| `cache_read_tokens` | integer (≥0) | | Input tokens served from the provider's prompt cache. |
| `cache_creation_tokens` | integer (≥0) | | Input tokens written to the provider's prompt cache. |
| `cost_usd` | number (≥0) | | Billed cost of the call in USD. |
| `temperature` | number | | Sampling temperature. Only a caller that set it can fill it. |
| `finish_reason` | string | | Provider's stop reason, e.g. `"stop"`, `"length"`, `"tool_calls"`. |
| `request_id` | string (≥1) | | The provider's request id, for reconciliation with provider logs. |
| `internal_reasoning` | `ContentRef` | | Raw internal reasoning / chain-of-thought emitted by the model **alongside and distinct from its final output**, stored in the content library. See note below. |

### `internal_reasoning`

Modern foundation models expose an internal reasoning channel separate from the visible answer. This field references that raw reasoning trace as the provider returned it:

| Provider | Source channel |
|---|---|
| DeepSeek / vLLM / OpenRouter | `reasoning_content` |
| OpenAI (o-series) | reasoning tokens / reasoning summary |
| Anthropic | extended-thinking (`thinking`) blocks |
| Gemini | thoughts / thinking |

> **Not the same as the `Thinking` behavior.** `internal_reasoning` is the *model's* own chain-of-thought attached to a single invocation, and can appear on **any** record that carries a `model_invocation` (e.g. a `ToolCalling` or `Acting` record). The `Thinking` behavior, by contrast, records a *deliberate agent thinking step* the SDK caller chose to log, with its own `output_payload`. A record can have both.

---

## Behavior records

Each section lists only the fields **added on top of** `BaseRecord`. The ten behaviors are the roles a step can play in a decision cycle; *how* a step was done (which tool, which model, read or write) is a field, not a behavior.

### `Observing` — the event that woke the agent

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Observing"` | ✅ | Discriminator constant. |
| `trigger_source` | string (≥1) | ✅ | Where the trigger came from. Prefer a stable URI-like name, e.g. `"claude-code://user_prompt"`, `"arena://fixtures/<code>/window_open"`. |
| `trigger_type` | enum | ✅ | `"signal_trigger"` (a system event), `"cron_trigger"` (a schedule), `"human_trigger"` (a person's message or action), `"outcome_trigger"` (the result of an earlier action: a settlement, a test result, a revert) or `"agent_trigger"` (another agent or a parent harness). |
| `trigger_description` | string (≥1) | ✅ | Human-readable description of the trigger. |
| `trigger_payload_summary` | string (≤4096) | ✅ | Summary of the trigger payload. |
| `event_ts_utc` | epoch ms | | When the triggering event occurred (may precede `client_ts_utc`). |

A sub-agent's first record is an `Observing` with `trigger_type` `"agent_trigger"` and a `sources` entry of kind `"record"` pointing at the parent's `Delegating` record. Data a tool returned is not an `Observing`: it is the `output_payload` of a `ToolCalling`.

### `ToolCalling` — an interaction with the world in the middle of the cycle

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"ToolCalling"` | ✅ | Discriminator constant. |
| `tool_meta` | `ToolMeta` | ✅ | Which tool was called (see below). |
| `input_payload` | `ContentRef` | ✅ | The input sent to the tool. |
| `output_payload` | `ContentRef` | ✅ | The result returned by the tool. |
| `outcome` | `Outcome` | ✅ | Result of the call. |
| `description` | string (≥1) | | What the call was for. |
| `effect` | enum | | What the call did to the world: `"read"`, `"write"` or `"execute"`. |

**`ToolMeta`** — open object (unknown keys are allowed):

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string (≥1) | ✅ | The tool's name. |
| `call_id` | string (≥1) | ◐ | The harness's own id for this call (OpenTelemetry `gen_ai.tool.call.id`, ATIF `tool_call_id`, Claude Code `tool_use_id`). |
| `tool_type` | enum | ◐ | `"function"`, `"mcp"`, `"skill"`, `"subagent"`, `"shell"`, `"http"` or `"datastore"`. |
| `namespace` | string (≥1) | | The application's grouping of tools, e.g. an MCP server name. |
| `server` | string (≥1) | | The server that executed the call, when there is one. |
| `version` | string (≥1) | | The tool's version. |

Handing a goal to another agent is `Delegating`, not a `ToolCalling` with `tool_type` `"subagent"`; writing to memory is `Memorizing`. Reading memory, files or data stores is `ToolCalling`.

### `Thinking` — analysis, decision, or an explicit plan

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Thinking"` | ✅ | Discriminator constant. |
| `output_payload` | `ContentRef` | ✅ | The conclusion/output of the step. |
| `prompt` | `ContentRef` | | The question/instruction driving this thinking step, when there is a separate one. |
| `inputs` | `ThinkingInput`[] | | Inputs considered (see below). |
| `steps` | `PlanningStep`[] | | Present when the thinking produced an explicit plan. "Did it plan before acting" is answered by a `Thinking` with `steps` before the cycle's `Acting`. |
| `revision_of` | UUID v4 | | The earlier `Thinking` record whose plan this one revises. |

**`ThinkingInput`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `input_payload` | `ContentRef` | ✅ | The input content. |
| `input_record_id` | UUID v4 | | Reference to a prior record this input came from. |

**`PlanningStep`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `index` | integer (≥0) | ✅ | Position of the step. |
| `description` | string (≥1) | ✅ | What the step does. |
| `depends_on` | integer[] (≥0) | | Indices of steps this one depends on. |

The `0.4` behavior `Planning` is folded into `Thinking`; stored `0.4` records keep it.

### `Acting` — the terminal commitment that resolves the cycle

Handing the result over or writing it back: submitting a prediction, filling an order, giving the final answer, concluding a stage. Side effects along the way are `ToolCalling`.

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Acting"` | ✅ | Discriminator constant. |
| `action_type` | string | ✅ | Namespaced `<domain>.<verb>`, lowercase, dot-separated, at least two segments: `"prediction.submit"`, `"order.fill"`, `"order.close"`, `"answer.final"`, `"git.commit"`, `"message.send"`, `"stage.conclude"`, `"task.abandon"`. Applications add their own domains. |
| `target_system` | string (≥1) | ✅ | System being acted upon (e.g. `"public-chain"`). |
| `action_summary` | string (≥1) | ✅ | Human-readable summary of the action. |
| `execution_status` | enum | ✅ | `"confirmed"`, `"failed"`, `"simulated"`, `"pending"` or `"cancelled"`. |
| `outcome` | `Outcome` | ✅ | Result of the commitment. |
| `parameters` | object (open) | | Action parameters. |
| `execution_id` | string | conditional | External execution id (e.g. tx hash). **Required** when `target_system` is `"public-chain"` and `execution_status` is `"confirmed"`. |

### `Reflecting` — the agent's evaluation of its own earlier behavior

During the cycle (`record_phase` `"concurrent"`: reading a test run, checking an edit) or after it (`"post_execution"`: a settlement, a retrospective).

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Reflecting"` | ✅ | Discriminator constant. |
| `inputs` | `ReflectingInput`[] | ✅ | Prior material being reflected on (same shape as `ThinkingInput`). |
| `output_payload` | `ContentRef` | ✅ | The reflection's conclusion. |
| `kind` | enum | | `"process"` (reviewing how it worked), `"evaluation"` (judging the output against criteria) or `"settlement"` (an external result coming back). |

**`ReflectingInput`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `input_payload` | `ContentRef` | ✅ | The input content. |
| `input_record_id` | UUID v4 | | Reference to a prior record this input came from. |

### `Attesting` — a person's disposition of a pending item

Submitted by the application on the person's behalf, not by the agent's own instrumentation; the SDKs have a separate entry point for it (`submitAttesting` / `submit_attesting`). When the agent asked (an `Escalating` record), the answer lists that record in `upstream_record_id`.

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Attesting"` | ✅ | Discriminator constant. |
| `executor` | `"human"` | ✅ | Always `"human"`. |
| `operator_id` | string (≥1) | ✅ | The person who made the disposition. |
| `disposition` | enum | ✅ | `"approve"` (accepted as proposed), `"edit"` (changed it), `"reject"` (refused), `"cancel"` (the person stopped the pending item) or `"no_response"` (nobody answered: a headless run, or the wait ran out). |
| `gate_kind` | string (≥1) | ✅ | Kind of checkpoint, defined by the application. Starting registry: `"column"`, `"plan"`, `"permission"`, `"question"`, `"deploy"`. |
| `written_by` | `WrittenBy` | ✅ | Which component wrote the record, with which credential. |
| `outcome` | `Outcome` | ✅ | `"success"` when a disposition was recorded; `"timeout"` for `no_response`; `"cancelled"` for `cancel`. |
| `decision` | any | | Structured decision content: the value the person chose or entered. Its shape is defined by the application. |
| `reason` | string (≥1) | conditional | **Required** when `disposition` is `"reject"`. |
| `patch` | object (open) | | Changes to the original parameters when `disposition` is `"edit"`. |
| `seen_digest` | string (≥1) | | Digest of what the person saw when deciding. |
| `seen_completeness` | enum | ◐ | Whether what the person saw covered everything the decision depended on: `"complete"`, `"partial"` or `"unknown"`. |
| `channel` | enum | ◐ | `"interactive"` (the person was present), `"async"` (handled later from a queue) or `"headless"` (no person could answer). |
| `policy_snapshot` | object (open) | ◐ | Policy in force at the time, or a content reference to it. |
| `effects` | `ContentRef` | | Side effects of the disposition in the application, e.g. configuration or rule changes. |

### `Escalating` — the agent hands a decision to a person

A question, a permission request, a plan to approve, or giving up and handing the work over. Responsibility moves to the person when this is written; the person's disposition is a separate `Attesting` record.

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Escalating"` | ✅ | Discriminator constant. |
| `kind` | enum | ✅ | `"question"`, `"permission"`, `"plan"` or `"handoff"`. |
| `asked` | `ContentRef` | ✅ | What was put to the person. |
| `outcome` | `Outcome` | ✅ | `"success"` when a person disposed of it, `"timeout"` when nobody answered, `"cancelled"` when withdrawn. |
| `options` | string[] (≤32) | | The choices offered, if any. |
| `default` | string | | The option proposed as default, if any. |

`duration_ms` on an `Escalating` record is how long the item waited.

### `Delegating` — the agent hands a goal to another agent

Spawning a sub-agent, handing the work off, or messaging another agent. The delegate's own cycle lives in its own session; this agent stays responsible for the result.

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Delegating"` | ✅ | Discriminator constant. |
| `kind` | enum | ✅ | `"spawn"`, `"handoff"` or `"message"`. |
| `goal` | `ContentRef` | ✅ | What the delegate was asked to do. |
| `outcome` | `Outcome` | ✅ | How the delegation ended. |
| `delegate_agent_id` | string (≥1) | | The delegate's agent id when it has one, else its type or name. |
| `child_session_id` | string (≥1) | | The session that holds the delegate's own records. |
| `awaited` | boolean | | Whether this agent waited for the result. |
| `result` | `ContentRef` | | What came back. |

### `Memorizing` — a write to state that outlives the cycle

Memory, standing rules, skills, settings, a knowledge base. What is written here shapes later cycles, often invisibly, so it is recorded apart from ordinary tool calls. Reading such state is `ToolCalling`.

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Memorizing"` | ✅ | Discriminator constant. |
| `scope` | enum | ✅ | How far the written state reaches: `"session"`, `"project"`, `"user"`, `"customer"`, `"org"` or `"global"`. |
| `target` | `ContentRef` | ✅ | What was written. Put its location in `notes` or `tags` if needed. |
| `op` | enum | ✅ | `"add"`, `"update"` or `"delete"`. |
| `outcome` | `Outcome` | ✅ | Whether the write took effect. |
| `approved_by` | UUID v4 | | The `Attesting` record of the person who confirmed this write, when one did. |

### `Other` — catch-all for behaviors outside the taxonomy

| Field | Type | Required | Description |
|---|---|---|---|
| `behavior` | `"Other"` | ✅ | Discriminator constant. |
| `label` | string (≥1) | ✅ | Short label naming the behavior, e.g. `"context.compaction"`. |
| `data` | object (open) | ✅ | Arbitrary structured payload. |
| `proposed_behavior` | string (≥1) | | The behavior the writer thinks this should be, if the taxonomy lacked it. |

A cycle's conclusion or the write-back of its result is `Acting`, not `Other`.

---

## Sessions and cycles

A `session_id` groups the records of one decision cycle: it opens with an `Observing` and closes with an `Acting` (or with an `Attesting` whose disposition is `reject` or `cancel`). After the close, an `Observing` with `trigger_type` `"outcome_trigger"` and the `Reflecting` it leads to (a settlement, a retrospective) belong to the same session without reopening it. After an `Escalating` the cycle is suspended until the matching `Attesting` arrives. A `Delegating` record's delegate runs in another session, named by `child_session_id`.

The server does not enforce this shape; it measures it (how many sessions open and close as described) alongside completeness.

---

## Shared scalar types

| Name | Definition |
|---|---|
| `UuidV4` | string, `format: uuid` |
| `EpochMs` | integer ≥ 0 — milliseconds since the Unix epoch |
| `BehaviorType` | enum: `Observing`, `ToolCalling`, `Thinking`, `Acting`, `Reflecting`, `Attesting`, `Escalating`, `Delegating`, `Memorizing`, `Other` |
| `Sha256Hex` | string of 64 lowercase hex characters |
| `Executor` | enum: `ai`, `det`, `human` |
| `RecordPhase` | enum: `pre_execution`, `concurrent`, `post_execution` |
| `Outcome` | enum: `success`, `failure`, `denied`, `escalated`, `timeout`, `cancelled` |
| `DecidedBy` | enum: `human`, `model`, `rule`, `policy`, `classifier`, `config`, `consensus` |

---

## Cross-field rules

Four rules depend on more than one field. The JSON Schema expresses them with `if`/`then`; the server and both SDKs enforce them:

- `Acting` with `target_system` `"public-chain"` and `execution_status` `"confirmed"` requires `execution_id`.
- `Attesting` with `disposition` `"reject"` requires `reason`.
- `Attesting` with `disposition` `"no_response"` requires `outcome` `"timeout"`.
- `Attesting` with `disposition` `"cancel"` requires `outcome` `"cancelled"`.

---

## Size limits

Beyond the JSON Schema constraints, the SDKs enforce size limits before any network call (see `SIZE_LIMITS` in each SDK), and the server enforces the record and batch limits again: per-record JSON ≤ 64 KB, per-batch JSON ≤ 1 MB (and ≤ 50 records), `Acting.parameters` and `Other.data` ≤ 16 KB. Content is not part of the record: the server limits each uploaded object (64 MiB by default, set by its operator).

---

## Mapping to other vocabularies

The behaviors are RL's own; this table says where each one lands in the vocabularies other tools read. It lives in documentation and exporters, not in records.

| RL | OpenTelemetry GenAI | OpenInference | ATIF |
|---|---|---|---|
| `Observing` | — (the input of `invoke_agent`) | `CHAIN` root input | step with `source: user` |
| `ToolCalling` | `execute_tool` | `TOOL`, `RETRIEVER` | `tool_calls` / `observation` |
| `Thinking` | `chat`, `text_completion`; plan span | `LLM` | `reasoning_content` |
| `Acting` | — (folded into `execute_tool`) | `TOOL` | terminal action (`submit`) |
| `Reflecting` | — | — (`EVALUATOR` is an external judge) | — |
| `Attesting` | — | — | — |
| `Escalating` | — | — | — |
| `Delegating` | `invoke_agent`, `create_agent` | `AGENT` | `subagent_trajectory_ref` |
| `Memorizing` | — | `MEMORY` (where implemented) | — |
| `Other` | custom operation | `UNKNOWN` | `extra` |

---

## Changelog

| Version | Change |
|---|---|
| `0.5` | Behaviors: `Planning` folded into `Thinking` (`steps`, `revision_of`); new `Escalating`, `Delegating`, `Memorizing`. Base: new `error_type`, `written_by` (on every record), `on_behalf_of_agent_id`, `classification`; `outcome` gains `cancelled` and is required on `Acting`, `Attesting`, `Escalating`, `Delegating`, `Memorizing`; `parent_record_id` removed. `ModelInvocation`: `invocation_kind`, `replay_of`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`; `model_version` removed. `Verdict.decided_by` becomes an enum; `sources`, `counterfactual`, `dissent` removed; `SourceDescriptor.record_id` removed. `Observing.trigger_type` gains `human_trigger`, `outcome_trigger`, `agent_trigger`; `external_trigger_id` removed. `ToolCalling.tool_meta` typed (`call_id`, `tool_type`, …), `description` optional, `effect` added. `Thinking.prompt` and `.inputs` optional. `Acting.action_type` namespaced, `dry_run` removed, `parameters` optional, `execution_status` gains `cancelled`. `Reflecting.kind`. `Attesting`: `cancel`, `no_response`, `channel`, `seen_completeness`; `evidence_refs` removed. `Other.proposed_behavior`. Requirement levels and completeness; session rules. Writes accept `0.5` only. Previous schema in [`history/0.4/`](./history/0.4/). |
| `0.4` | Raw content moves out of records into the content library (`ContentRef` at every content position). New required base fields `executor` and `record_phase`; new optional base fields `outcome`, `duration_ms`, `sources`, `verdict`. `ToolCalling.success` replaced by the required `outcome`. New behavior `Attesting`. Writes accept `0.4` only; the label `1.0` is retired. Previous schema in [`history/0.3/`](./history/0.3/). |
| `0.3` | Added `ModelInvocation.internal_reasoning` — captures the model's raw chain-of-thought, distinct from its final output. |
| `0.2` | (snapshot in [`history/0.2/`](./history/0.2/)) |
| `0.1` | (snapshot in [`history/0.1/`](./history/0.1/)) |
