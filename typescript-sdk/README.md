# reasoning-ledger-sdk

TypeScript/Node.js SDK for the [Reasoning Ledger](https://github.com/StairAI/Reasoning-Ledger) — an append-only audit trail for AI agent reasoning.

## Install

```sh
npm install reasoning-ledger-sdk
# or
pnpm add reasoning-ledger-sdk
```

Requires **Node.js 18+** and **TypeScript 5+** (for ESM + `exactOptionalPropertyTypes`).

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

const endpoint = "https://stg-api.stair-ai.com"; // your Reasoning Ledger API base URL — required

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
  tool_meta: { tool_id: "polymarket_api", category: "external_api" },
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

// Acting — the commitment
await session.submit({
  behavior: "Acting",
  executor: "det",
  record_phase: "pre_execution",
  action_type: "trade",
  target_system: "broker-api",
  action_summary: "Hold current Spain win position",
  parameters: { symbol: "ESP_WIN", action: "hold" },
  dry_run: false,
  execution_status: "confirmed",
});
```

### Content: raw text never goes into a record

Prompts, payloads and internal reasoning live in the content library; a record holds a `ContentRef` (`{ sha256, bytes, media_type }`) at those positions. You can pass raw content there instead and the SDK uploads it first, then submits the record with the returned reference:

| You pass                                                      | Uploaded as                           |
| ------------------------------------------------------------- | ------------------------------------- |
| a string                                                      | `text/plain; charset=utf-8` (UTF-8)   |
| a `Uint8Array`                                                | `application/octet-stream`            |
| any other JSON value (object, array, number, boolean, null)   | `application/json` (`JSON.stringify`) |
| a `ContentRef` (keys exactly `sha256`, `bytes`, `media_type`) | nothing — sent as is                  |

Content positions: `ToolCalling.input_payload` / `output_payload`, `Thinking.prompt` / `output_payload` / `inputs[].input_payload`, `Reflecting.output_payload` / `inputs[].input_payload`, `model_invocation.internal_reasoning`, and `Attesting.effects`. The record is validated before anything is uploaded; a failed upload fails the submit (for a batch, before the batch is sent).

To manage content yourself:

```typescript
const ref = await client.putContent("long prompt text"); // or bytes; optional media type as 2nd argument
const bytes = await client.getContent(ref); // Uint8Array; also accepts the sha256 string
```

Uploads are idempotent (content is addressed by its SHA-256). Deleted or unknown content raises `NotFoundError`; content over the server's size limit raises `ValidationError`.

### Attesting — a person's disposition

```typescript
await session.submitAttesting({
  operator_id: "u-1024",
  disposition: "approve", // | "reject" (needs a reason) | "edit"
  gate_kind: "trade-approval",
  decision: { position: "hold" },
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

All eight behaviors extend `BaseRecord`, which requires `executor` and `record_phase` and accepts `outcome`, `duration_ms`, `sources` and `verdict`. The `behavior` field is a discriminant; TypeScript narrows the union automatically.

| Behavior      | Required fields (beyond base)                                                                 |
| ------------- | --------------------------------------------------------------------------------------------- |
| `Observing`   | `trigger_source`, `trigger_type`, `trigger_description`, `trigger_payload_summary`            |
| `Planning`    | `goal`, `steps`                                                                               |
| `Thinking`    | `prompt`, `inputs`, `output_payload`                                                          |
| `Acting`      | `action_type`, `target_system`, `action_summary`, `parameters`, `dry_run`, `execution_status` |
| `Reflecting`  | `inputs`, `output_payload`                                                                    |
| `ToolCalling` | `tool_meta`, `description`, `input_payload`, `output_payload`, `outcome`                      |
| `Attesting`   | `operator_id`, `disposition`, `gate_kind`, `written_by` (`executor` must be `human`)          |
| `Other`       | `label`, `data`                                                                               |

Two cross-field rules are checked locally as well: an `Acting` record with `target_system` `public-chain` and `execution_status` `confirmed` needs an `execution_id`, and an `Attesting` record with `disposition` `reject` needs a `reason`.

### Auto-filled fields

The SDK fills these if you omit them:

| Field            | SDK default                       |
| ---------------- | --------------------------------- |
| `record_id`      | Fresh UUID v4                     |
| `schema_version` | `"0.4"` (bundled constant)        |
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
  endpoint: "https://stg-api.stair-ai.com",

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

Use `newRecordId()` when building dependency edges where a child needs to reference an as-yet-unsubmitted record via `upstream_record_id` or `parent_record_id`.

---

## License

MIT
