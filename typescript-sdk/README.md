# reasoning-ledger-sdk

TypeScript/Node.js SDK for the [Reasoning Ledger](https://github.com/StairAI/Reasoning-Ledger) — a tamper-evident audit trail for AI agent reasoning.

## Install

```sh
npm install reasoning-ledger-sdk
# or
pnpm add reasoning-ledger-sdk
```

Requires **Node.js 18+** and **TypeScript 5+** (for ESM + `exactOptionalPropertyTypes`).

## Quick start

### 1. Register an agent

Agent registration is idempotent on `(owner, name)` — calling it again with the same name returns the existing agent.

```typescript
import { LedgerClient } from "reasoning-ledger-sdk";

const { agent_id, agent_wallet_address } = await LedgerClient.registerAgent({
  apiKey: process.env.STAIRAI_API_KEY!,
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
  name: "my-agent",
});
```

### 2. Create a client

```typescript
const client = new LedgerClient({
  apiKey: process.env.STAIRAI_API_KEY!,
  agentId: agent_id,
});
```

The constructor performs no network call. The API key and agent ID are validated lazily on the first request.

### 3. Open a session and submit records

A `Session` pins a `session_id` so you don't have to pass it on every record. It is purely local sugar — there is no server-side session lifecycle.

```typescript
const session = client.newSession(); // auto-generates a session_id

// Observing — the trigger that woke your agent
await session.submit({
  behavior: "Observing",
  trigger_source: "sportradar",
  trigger_type: "signal_trigger",
  trigger_description: "Match update: Spain vs Morocco, minute 47",
  trigger_payload_summary: "Spain xG 0.41, possession 62%, shots 8-2",
});

// ToolCalling — external data fetch
await session.submit({
  behavior: "ToolCalling",
  tool_meta: { tool_id: "polymarket_api", category: "external_api" },
  description: "Fetch current Spain win odds",
  input_payload: JSON.stringify({ market: "esp_mar" }),
  output_payload: JSON.stringify({ spain_win: 0.73 }),
  success: true,
});

// Thinking — analysis and decision
await session.submit({
  behavior: "Thinking",
  prompt: "Given xG 0.41 and odds 0.73, should I adjust the position?",
  inputs: [],
  output_payload: JSON.stringify({ recommendation: "hold", confidence: 0.81 }),
});

// Acting — the commitment
await session.submit({
  behavior: "Acting",
  action_type: "trade",
  target_system: "broker-api",
  action_summary: "Hold current Spain win position",
  parameters: { symbol: "ESP_WIN", action: "hold" },
  dry_run: false,
  execution_status: "confirmed",
});
```

### 4. Submit a batch

```typescript
const batchAck = await session.submitBatch([
  { behavior: "Thinking", prompt: "...", inputs: [], output_payload: "..." },
  { behavior: "Acting",   action_type: "...", /* ... */ },
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

All seven behaviors extend `BaseRecord`. The `behavior` field is a discriminant; TypeScript narrows the union automatically.

| Behavior | Required fields (beyond base) |
|---|---|
| `Observing` | `trigger_source`, `trigger_type`, `trigger_description`, `trigger_payload_summary` |
| `Planning` | `goal`, `steps` |
| `Thinking` | `prompt`, `inputs`, `output_payload` |
| `Acting` | `action_type`, `target_system`, `action_summary`, `parameters`, `dry_run`, `execution_status` |
| `Reflecting` | `inputs`, `output_payload` |
| `ToolCalling` | `tool_meta`, `description`, `input_payload`, `output_payload`, `success` |
| `Other` | `label`, `data` |

### Auto-filled fields

The SDK fills these if you omit them:

| Field | SDK default |
|---|---|
| `record_id` | Fresh UUID v4 |
| `schema_version` | `"0.2"` (bundled constant) |
| `client_ts_utc` | `Date.now()` (epoch ms) |
| `agent_id` | From `LedgerClientConfig.agentId` |

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
  await session.submit({ /* ... */ });
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

| Class | `code` | When |
|---|---|---|
| `ValidationError` | `validation_failed` | Local schema check failed; record never sent |
| `AuthError` | `auth_invalid` | API key rejected |
| `RateLimitError` | `rate_limited` | Server rate-limited the request |
| `NetworkError` | `network_failed` | Request never reached the server after retries |
| `ServerError` | `server_5xx` | Non-retryable 5xx from server |
| `IdempotencyConflictError` | `record_id_conflict` | Same `record_id` submitted with different body |
| `NotFoundError` | `not_found` | Lookup target does not exist |

---

## Configuration

```typescript
import type { LedgerClientConfig } from "reasoning-ledger-sdk";

const config: LedgerClientConfig = {
  apiKey: "sl_...",
  agentId: "uuid-v4",

  // Target environment — defaults to "production"
  environment: "production", // | "staging" | "development"

  // Override base URL (takes precedence over `environment`)
  endpoint: "https://custom.api.example.com",

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

Inject any object implementing `HttpTransport` to intercept or mock network calls:

```typescript
import type { HttpRequest, HttpResponse, HttpTransport } from "reasoning-ledger-sdk";

const loggingTransport: HttpTransport = {
  async request(req: HttpRequest): Promise<HttpResponse> {
    console.log(req.method, req.url);
    return fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
      .then(async (r) => ({
        status: r.status,
        headers: Object.fromEntries(r.headers),
        body: await r.text(),
      }));
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
  name:      string;
  wallet?:   AgentWalletInput;  // BYOW only
  metadata?: AgentMetadata;     // description, website, tags
}
```

#### `LedgerClient.resolveAgentId(opts)` → `Promise<string>`

Look up an `agent_id` by human-readable name.

```typescript
opts: { apiKey: string; name: string }
```

### Instance methods

#### `client.submit(record)` → `Promise<RecordAck>`

Submit one record.

#### `client.submitBatch(records)` → `Promise<BatchAck>`

Submit up to 50 records in one request.

#### `client.getRecord(record_id)` → `Promise<Record>`

Fetch a single stored record.

#### `client.getSession(session_id)` → `Promise<SessionFetch>`

Fetch every record in a session, ordered by `server_ts_utc`.

#### `client.getTrace(opts?)` → `Promise<TracePage>`

Paginated read of the agent's full trace.

```typescript
opts?: { before?: string; limit?: number }  // cursor-based pagination
```

#### `client.newSession(session_id?)` → `Session`

Create a local session handle. Generates a `session_id` if not supplied.

### Session methods

#### `session.submit(record)` → `Promise<RecordAck>`

Same as `client.submit`; `session_id` is auto-injected.

#### `session.submitBatch(records)` → `Promise<BatchAck>`

Same as `client.submitBatch`; `session_id` is auto-injected on each record.

#### `session.id` → `string`

The bound `session_id` (read-only).

### Utility functions

```typescript
import { isValidRecordId, newRecordId, nowEpochMs } from "reasoning-ledger-sdk";

newRecordId()              // → fresh UUID v4 string
nowEpochMs()               // → current epoch milliseconds (integer)
isValidRecordId("...")     // → boolean — is the string a valid UUID v4?
```

Use `newRecordId()` when building dependency edges where a child needs to reference an as-yet-unsubmitted record via `upstream_record_id` or `parent_record_id`.

---

## License

MIT
