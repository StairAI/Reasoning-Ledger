# reasoning-ledger-sdk

TypeScript/Node.js SDK for the [Reasoning Ledger](https://github.com/StairAI/Reasoning-Ledger) — an append-only audit trail for AI agent reasoning.

## Install

```sh
npm install reasoning-ledger-sdk
# or
pnpm add reasoning-ledger-sdk
```

Requires **Node.js 18+** and **TypeScript 5+** (for ESM + `exactOptionalPropertyTypes`).

### Upgrading to schema 0.5

- Records are stamped `schema_version` `"0.5"`, and a server accepts writes of its own schema version only: upgrade the SDK and the server together.
- `Planning` is gone: record a plan as `Thinking` with `steps`. New behaviors: `Escalating`, `Delegating`, `Memorizing` (see [Behavior types](#behavior-types)).
- `outcome` is required on `Acting`, `Attesting` (also through `submitAttesting`), `Escalating`, `Delegating` and `Memorizing`, as on `ToolCalling`.
- `Acting.action_type` is a namespaced `<domain>.<verb>`, e.g. `answer.final`, `git.commit`; `dry_run` is gone and `parameters` is optional.
- `tool_meta` needs a `name`; `verdict.decided_by` is one of `human`, `model`, `rule`, `policy`, `classifier`, `config`, `consensus`.
- Removed: `parent_record_id`, `model_invocation.model_version`, `Observing.external_trigger_id`, `Attesting.evidence_refs` (use `sources`).

### Upgrading from 0.3

- `endpoint` is required — in `LedgerClientConfig` and in the `registerAgent` / `resolveAgentId` options. The `environment` option and the `ENDPOINTS` constant are gone (their built-in hosts never resolved).
- Records use schema 0.4: every record needs `executor` and `record_phase`; `ToolCalling.success` is replaced by `outcome`.
- Prompts, payloads and internal reasoning are content references. Pass raw values and the SDK uploads them (see [Content](#content-raw-text-never-goes-into-a-record)); `SIZE_LIMITS` no longer caps them.
- New: `submitAttesting`, `putContent`, `getContent`. `agent_wallet_address` may be `null`.

## Quick start

### 1. Register an agent

Agent registration is idempotent on `(owner, name)` — calling it again with the same name returns the existing agent.

```typescript
import { LedgerClient } from "reasoning-ledger-sdk";

const endpoint = "https://api.stair-ai.com"; // the hosted service, or your own server — required

const { agent_id, agent_wallet_address } = await LedgerClient.registerAgent({
  apiKey: process.env.STAIRAI_API_KEY!,
  endpoint,
  name: "my-agent",
  metadata: {
    description: "Multi-step football match predictor",
    tags: ["sports", "prediction"],
  },
});

// Store agent_id — you'll need it every time you construct LedgerClient.
```

If you already have an `agent_id` (e.g. stored in config), skip registration and go straight to step 2.

To look up an agent ID by name at startup:

```typescript
const agentId = await LedgerClient.resolveAgentId({
  apiKey: process.env.STAIRAI_API_KEY!,
  endpoint,
  name: "my-agent",
});
```

### 2. Create a client

```typescript
const client = new LedgerClient({
  apiKey: process.env.STAIRAI_API_KEY!,
  agentId: agent_id,
  endpoint,
});
```

`endpoint` has no default: without it the constructor throws `ValidationError` (a trailing slash is ignored). The constructor performs no network call. The API key and agent ID are validated lazily on the first request.

### 3. Open a session and submit records

A `Session` pins a `session_id` so you don't have to pass it on every record. It is purely local sugar — there is no server-side session lifecycle.

Every record states who performed the step (`executor`: `ai`, `det` or `human`) and when it was written relative to that step (`record_phase`: `pre_execution`, `concurrent` or `post_execution`). The SDK has no defaults for either, except in `submitAttesting` (below).

```typescript
const session = client.newSession(); // auto-generates a session_id

// Observing — the trigger that woke your agent
await session.submit({
  behavior: "Observing",
  executor: "det",
  record_phase: "post_execution",
  trigger_source: "sportradar",
  trigger_type: "signal_trigger",
  trigger_description: "Match update: Spain vs Morocco, minute 47",
  trigger_payload_summary: "Spain xG 0.41, possession 62%, shots 8-2",
});

// ToolCalling — external data fetch. Payloads are uploaded as content (see below).
await session.submit({
  behavior: "ToolCalling",
  executor: "det",
  record_phase: "post_execution",
  tool_meta: { name: "polymarket_api", tool_type: "http" },
  description: "Fetch current Spain win odds",
  input_payload: { market: "esp_mar" },
  output_payload: { spain_win: 0.73 },
  outcome: "success",
});

// Thinking — analysis and decision
await session.submit({
  behavior: "Thinking",
  executor: "ai",
  record_phase: "post_execution",
  prompt: "Given xG 0.41 and odds 0.73, should I adjust the position?",
  inputs: [],
  output_payload: { recommendation: "hold", confidence: 0.81 },
});

// Acting — the commitment that closes the cycle
await session.submit({
  behavior: "Acting",
  executor: "det",
  record_phase: "pre_execution",
  action_type: "position.hold", // namespaced <domain>.<verb>
  target_system: "broker-api",
  action_summary: "Hold current Spain win position",
  parameters: { symbol: "ESP_WIN" },
  execution_status: "confirmed",
  outcome: "success",
});
```

### Content: raw text never goes into a record

Prompts, payloads, internal reasoning and other raw text live in the content library; a record holds a `ContentRef` (`{ sha256, bytes, media_type }`) at those positions. You can pass raw content there instead and the SDK uploads it first, then submits the record with the returned reference:

| You pass                                                      | Uploaded as                           |
| ------------------------------------------------------------- | ------------------------------------- |
| a string                                                      | `text/plain; charset=utf-8` (UTF-8)   |
| a `Uint8Array`                                                | `application/octet-stream`            |
| any other JSON value (object, array, number, boolean, null)   | `application/json` (`JSON.stringify`) |
| a `ContentRef` (keys exactly `sha256`, `bytes`, `media_type`) | nothing — sent as is                  |

Content positions: `ToolCalling.input_payload` / `output_payload`, `Thinking.prompt` / `output_payload` / `inputs[].input_payload`, `Reflecting.output_payload` / `inputs[].input_payload`, `Escalating.asked`, `Delegating.goal` / `result`, `Memorizing.target`, `Attesting.effects`, `model_invocation.internal_reasoning`, and `model_invocation.replay_of` unless it holds a record id (a UUID string, sent as is). The record is validated before anything is uploaded; a failed upload fails the submit (for a batch, before the batch is sent).

To manage content yourself:

```typescript
const ref = await client.putContent("long prompt text"); // or bytes; optional media type as 2nd argument
const bytes = await client.getContent(ref); // Uint8Array; also accepts the sha256 string
```

Uploads are idempotent (content is addressed by its SHA-256). Deleted or unknown content raises `NotFoundError`; content over the server's size limit raises `ValidationError`.

### Escalating and Attesting — the agent asks, a person answers

```typescript
// The agent handed the decision to a person; written once the wait is over.
const asked = await session.submit({
  behavior: "Escalating",
  executor: "ai",
  record_phase: "post_execution",
  kind: "permission", // | "question" | "plan" | "handoff"
  asked: "Hold or close the Spain win position?", // uploaded as content
  options: ["hold", "close"],
  default: "hold",
  outcome: "success", // a person answered; "timeout" if nobody did, "cancelled" if withdrawn
  duration_ms: 42_000, // how long it waited
});

// The person's disposition, written by the review application, points back at it.
await session.submitAttesting({
  operator_id: "u-1024",
  disposition: "approve", // | "edit" | "reject" (needs a reason) | "cancel" | "no_response"
  outcome: "success", // "cancelled" for cancel, "timeout" for no_response
  gate_kind: "permission",
  decision: { position: "hold" },
  upstream_record_id: [asked.record_id],
  written_by: { component: "review-console", credential: "svc-review" },
});
```

`submitAttesting` sets `behavior: "Attesting"`, `executor: "human"`, and `record_phase: "concurrent"` unless you pass one. `effects` may be raw content.

### 4. Submit a batch

```typescript
const batchAck = await session.submitBatch([
  {
    behavior: "Thinking",
    executor: "ai",
    record_phase: "post_execution",
    prompt: "...",
    inputs: [],
    output_payload: "...",
  },
  {
    behavior: "Acting",
    executor: "det",
    record_phase: "pre_execution",
    action_type: "..." /* ... */,
  },
]);

for (const result of batchAck.results) {
  if ("code" in result) {
    console.error("Record failed:", result.record_id, result.code, result.message);
  }
}
```

Up to 50 records per batch. Per-record validation runs locally before the network call; only locally-valid records are sent. Partial server-side failure does not throw — inspect `BatchAck.results`.

---

## Behavior types

All ten behaviors extend `BaseRecord`, which requires `executor` and `record_phase` and accepts `outcome`, `duration_ms`, `error_type`, `sources`, `verdict`, `written_by`, `on_behalf_of_agent_id` and `classification`. The `behavior` field is a discriminant; TypeScript narrows the union automatically.

| Behavior      | Required fields (beyond base)                                                                       | Notable optional fields                                      |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `Observing`   | `trigger_source`, `trigger_type`, `trigger_description`, `trigger_payload_summary`                  | `event_ts_utc`                                               |
| `ToolCalling` | `tool_meta` (with `name`), `input_payload`, `output_payload`, `outcome`                             | `description`, `effect`, `tool_meta.call_id` / `tool_type`   |
| `Thinking`    | `output_payload`                                                                                    | `prompt`, `inputs`, `steps` (a plan), `revision_of`          |
| `Acting`      | `action_type` (`<domain>.<verb>`), `target_system`, `action_summary`, `execution_status`, `outcome` | `parameters`, `execution_id`                                 |
| `Reflecting`  | `inputs`, `output_payload`                                                                          | `kind`                                                       |
| `Attesting`   | `operator_id`, `disposition`, `gate_kind`, `written_by`, `outcome` (`executor` must be `human`)     | `decision`, `reason`, `patch`, `channel`, `effects`          |
| `Escalating`  | `kind`, `asked`, `outcome`                                                                          | `options`, `default`                                         |
| `Delegating`  | `kind`, `goal`, `outcome`                                                                           | `delegate_agent_id`, `child_session_id`, `awaited`, `result` |
| `Memorizing`  | `scope`, `target`, `op`, `outcome`                                                                  | `approved_by`                                                |
| `Other`       | `label`, `data`                                                                                     | `proposed_behavior`                                          |

Four cross-field rules are checked locally as well: an `Acting` record with `target_system` `public-chain` and `execution_status` `confirmed` needs an `execution_id`; an `Attesting` record with `disposition` `reject` needs a `reason`, one with `no_response` needs `outcome` `timeout`, and one with `cancel` needs `outcome` `cancelled`.

### Auto-filled fields

The SDK fills these if you omit them:

| Field            | SDK default                       |
| ---------------- | --------------------------------- |
| `record_id`      | Fresh UUID v4                     |
| `schema_version` | `"0.5"` (bundled constant)        |
| `client_ts_utc`  | `Date.now()` (epoch ms)           |
| `agent_id`       | From `LedgerClientConfig.agentId` |

---

## Error handling

All errors extend `LedgerError` and carry a stable `code` string:

```typescript
import {
  AuthError,
  IdempotencyConflictError,
  LedgerError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "reasoning-ledger-sdk";

try {
  await session.submit({
    /* ... */
  });
} catch (err) {
  if (err instanceof ValidationError) {
    // Local schema check failed — never reached the network
    console.error(err.details?.field, err.details?.reason);
  } else if (err instanceof RateLimitError) {
    const waitMs = err.details?.retry_after_ms;
    // back off and retry
  } else if (err instanceof LedgerError) {
    console.error(err.code, err.message);
  }
}
```

| Class                      | `code`               | When                                                                                         |
| -------------------------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `ValidationError`          | `validation_failed`  | Local schema or rule check failed (record never sent); missing `endpoint`; content too large |
| `AuthError`                | `auth_invalid`       | API key rejected                                                                             |
| `RateLimitError`           | `rate_limited`       | Server rate-limited the request                                                              |
| `NetworkError`             | `network_failed`     | Request never reached the server after retries                                               |
| `ServerError`              | `server_5xx`         | Non-retryable 5xx from server                                                                |
| `IdempotencyConflictError` | `record_id_conflict` | Same `record_id` submitted with different body                                               |
| `NotFoundError`            | `not_found`          | Lookup target does not exist, or content was deleted                                         |

---

## Configuration

```typescript
import type { LedgerClientConfig } from "reasoning-ledger-sdk";

const config: LedgerClientConfig = {
  apiKey: "sl_...",
  agentId: "uuid-v4",

  // Base URL of the Reasoning Ledger API — required, no default
  endpoint: "https://api.stair-ai.com",

  // Default ModelInvocation stamped on every record unless overridden per-record
  defaultModelInvocation: {
    provider: "anthropic",
    model_name: "claude-opus-4-7",
    tokens_in: 0,
    tokens_out: 0,
  },

  // Retry: 3 total attempts with 500 ms / 1 s / 2 s backoff (these are defaults)
  retry: {
    attempts: 3,
    backoffMs: [500, 1000, 2000],
  },

  // Custom HTTP transport — useful for tests
  httpTransport: myMockTransport,
};
```

### Custom HTTP transport

Inject any object implementing `HttpTransport` to intercept or mock network calls. Request bodies are a string (JSON) or a `Uint8Array` (content uploads); fill `bodyBytes` on the response so `getContent` gets binary content intact:

```typescript
import type { HttpRequest, HttpResponse, HttpTransport } from "reasoning-ledger-sdk";

const loggingTransport: HttpTransport = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    console.log(req.method, req.url);
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    const bodyBytes = new Uint8Array(await r.arrayBuffer());
    return {
      status: r.status,
      headers: Object.fromEntries(r.headers),
      body: new TextDecoder().decode(bodyBytes),
      bodyBytes,
    };
  },
};
```

---

## API reference

### Static methods

#### `LedgerClient.registerAgent(opts)` → `Promise<AgentRegistration>`

Register a new agent. Idempotent on `(owner, name)`.

```typescript
opts: {
  apiKey:    string;
  endpoint:  string;            // required
  name:      string;
  wallet?:   AgentWalletInput;  // BYOW only
  metadata?: AgentMetadata;     // description, website, tags
}
```

#### `LedgerClient.resolveAgentId(opts)` → `Promise<string>`

Look up an `agent_id` by human-readable name.

```typescript
opts: {
  apiKey: string;
  endpoint: string; // required
  name: string;
}
```

### Instance methods

#### `client.submit(record)` → `Promise<RecordAck>`

Submit one record.

#### `client.submitBatch(records)` → `Promise<BatchAck>`

Submit up to 50 records in one request.

#### `client.submitAttesting(input)` → `Promise<RecordAck>`

Submit an Attesting record; `behavior`, `executor` and (by default) `record_phase` are set for you.

#### `client.putContent(data, mediaType?)` → `Promise<ContentRef>`

Upload a string or `Uint8Array` to the content library.

#### `client.getContent(refOrSha256)` → `Promise<Uint8Array>`

Read content back as raw bytes.

#### `client.getRecord(record_id)` → `Promise<StoredRecord>`

Fetch a single stored record. Stored records also carry the server-assigned `server_ts_utc` and `sequence`.

#### `client.getSession(session_id)` → `Promise<SessionFetch>`

Fetch every record in a session, in the order the server received them (`sequence` ascending).

#### `client.getTrace(opts?)` → `Promise<TracePage>`

Paginated read of the agent's full trace, newest first.

```typescript
opts?: { before?: string; limit?: number }  // before = next_cursor of the previous page
```

#### `client.newSession(session_id?)` → `Session`

Create a local session handle. Generates a `session_id` if not supplied.

### Session methods

#### `session.submit(record)` → `Promise<RecordAck>`

Same as `client.submit`; `session_id` is auto-injected.

#### `session.submitBatch(records)` → `Promise<BatchAck>`

Same as `client.submitBatch`; `session_id` is auto-injected on each record.

#### `session.submitAttesting(input)` → `Promise<RecordAck>`

Same as `client.submitAttesting`; `session_id` is auto-injected.

#### `session.id` → `string`

The bound `session_id` (read-only).

### Utility functions

```typescript
import { isValidRecordId, newRecordId, nowEpochMs } from "reasoning-ledger-sdk";

newRecordId(); // → fresh UUID v4 string
nowEpochMs(); // → current epoch milliseconds (integer)
isValidRecordId("..."); // → boolean — is the string a valid UUID v4?
```

Use `newRecordId()` when building dependency edges where a child needs to reference an as-yet-unsubmitted record via `upstream_record_id`.

---

## License

MIT
