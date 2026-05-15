# reasoning-ledger

Python SDK for the [Reasoning Ledger](https://github.com/StairAI/Reasoning-Ledger) — a tamper-evident audit trail for AI agent reasoning.

## Install

```sh
pip install reasoning-ledger
```

Requires **Python 3.12+**. Dependencies: `pydantic>=2`, `httpx>=0.27`.

## Quick start

### 1. Register an agent

Agent registration is idempotent on `(owner, name)` — calling it again with the same name returns the existing agent.

```python
import os
from reasoning_ledger import LedgerClient, RegisterAgentOpts

reg = LedgerClient.register_agent(RegisterAgentOpts(
    api_key=os.environ["STAIRAI_API_KEY"],
    name="my-agent",
))

agent_id = reg["agent_id"]
# Store agent_id — you'll need it every time you construct LedgerClient.
```

If you already have an `agent_id` (e.g. stored in config), skip registration. To look up an agent ID by name at startup:

```python
from reasoning_ledger import LedgerClient, ResolveAgentOpts

agent_id = LedgerClient.resolve_agent_id(ResolveAgentOpts(
    api_key=os.environ["STAIRAI_API_KEY"],
    name="my-agent",
))
```

### 2. Create a client

```python
from reasoning_ledger import LedgerClient, LedgerClientConfig

client = LedgerClient(LedgerClientConfig(
    api_key=os.environ["STAIRAI_API_KEY"],
    agent_id=agent_id,
))
```

The constructor performs no network call. The API key and agent ID are validated lazily on the first request.

### 3. Open a session and submit records

A `Session` pins a `session_id` so you don't have to pass it on every record. It is purely local sugar — there is no server-side session lifecycle.

```python
import json

session = client.new_session()  # auto-generates a session_id

# Observing — the trigger that woke your agent
session.submit({
    "behavior": "Observing",
    "trigger_source": "sportradar",
    "trigger_type": "signal_trigger",
    "trigger_description": "Match update: Spain vs Morocco, minute 47",
    "trigger_payload_summary": "Spain xG 0.41, possession 62%, shots 8-2",
})

# ToolCalling — external data fetch
session.submit({
    "behavior": "ToolCalling",
    "tool_meta": {"tool_id": "polymarket_api", "category": "external_api"},
    "description": "Fetch current Spain win odds",
    "input_payload": json.dumps({"market": "esp_mar"}),
    "output_payload": json.dumps({"spain_win": 0.73}),
    "success": True,
})

# Thinking — analysis and decision
session.submit({
    "behavior": "Thinking",
    "prompt": "Given xG 0.41 and odds 0.73, should I adjust the position?",
    "inputs": [],
    "output_payload": json.dumps({"recommendation": "hold", "confidence": 0.81}),
})

# Acting — the commitment
session.submit({
    "behavior": "Acting",
    "action_type": "trade",
    "target_system": "broker-api",
    "action_summary": "Hold current Spain win position",
    "parameters": {"symbol": "ESP_WIN", "action": "hold"},
    "dry_run": False,
    "execution_status": "confirmed",
})
```

### 4. Submit a batch

```python
batch_ack = session.submit_batch([
    {"behavior": "Thinking", "prompt": "...", "inputs": [], "output_payload": "..."},
    {"behavior": "Acting", "action_type": "...", ...},
])

for result in batch_ack["results"]:
    if "code" in result:
        print("Record failed:", result["record_id"], result["code"], result["message"])
```

Up to 50 records per batch. Per-record validation runs locally before the network call; only locally-valid records are sent. Partial server-side failure does not raise — inspect `BatchAck["results"]`.

---

## Behavior types

All seven behaviors extend the base record fields. The `"behavior"` key is the discriminant.

| Behavior | Required fields (beyond base) |
|---|---|
| `"Observing"` | `trigger_source`, `trigger_type`, `trigger_description`, `trigger_payload_summary` |
| `"Planning"` | `goal`, `steps` |
| `"Thinking"` | `prompt`, `inputs`, `output_payload` |
| `"Acting"` | `action_type`, `target_system`, `action_summary`, `parameters`, `dry_run`, `execution_status` |
| `"Reflecting"` | `inputs`, `output_payload` |
| `"ToolCalling"` | `tool_meta`, `description`, `input_payload`, `output_payload`, `success` |
| `"Other"` | `label`, `data` |

### Auto-filled fields

The SDK fills these if you omit them:

| Field | SDK default |
|---|---|
| `record_id` | Fresh UUID v4 |
| `schema_version` | `"0.2"` (bundled constant) |
| `client_ts_utc` | Current epoch milliseconds |
| `agent_id` | From `LedgerClientConfig.agent_id` |

---

## Error handling

All errors inherit from `LedgerError` and carry a stable `code` string:

```python
from reasoning_ledger import (
    AuthError,
    IdempotencyConflictError,
    LedgerError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
)

try:
    session.submit({...})
except ValidationError as e:
    # Local schema check failed — never reached the network
    print(e.details.get("field"), e.details.get("reason"))
except RateLimitError as e:
    wait_ms = e.details.get("retry_after_ms")
    # back off and retry
except LedgerError as e:
    print(e.code, e.message)
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

```python
from reasoning_ledger import LedgerClientConfig

config = LedgerClientConfig(
    api_key="sl_...",
    agent_id="uuid-v4",

    # Target environment — defaults to "production"
    environment="production",  # | "staging" | "development"

    # Override base URL (takes precedence over `environment`)
    endpoint="https://custom.api.example.com",

    # Default model invocation stamped on every record unless overridden per-record
    default_model_invocation={
        "provider": "anthropic",
        "model_name": "claude-opus-4-7",
        "tokens_in": 0,
        "tokens_out": 0,
    },

    # Retry: 3 total attempts with 500 ms / 1 s / 2 s backoff (these are the defaults)
    retry={"attempts": 3, "backoff_ms": [500, 1000, 2000]},

    # Custom HTTP transport — useful for tests
    http_transport=my_mock_transport,
)
```

### Custom HTTP transport

Inject any object implementing the `HttpTransport` protocol to intercept or mock network calls:

```python
from reasoning_ledger import HttpRequest, HttpResponse, HttpTransport

class LoggingTransport:
    def request(self, req: HttpRequest) -> HttpResponse:
        print(req["method"], req["url"])
        # delegate to real httpx ...
```

---

## API reference

### Static / class methods

#### `LedgerClient.register_agent(opts)` → `AgentRegistration`

Register a new agent. Idempotent on `(owner, name)`.

```python
opts = RegisterAgentOpts(
    api_key="sl_...",
    name="my-agent",
    metadata=AgentMetadata(description="...", tags=["tag1"]),
    wallet=AgentWalletInput(address="0x..."),  # BYOW only
)
```

#### `LedgerClient.resolve_agent_id(opts)` → `str`

Look up an `agent_id` by human-readable name.

```python
opts = ResolveAgentOpts(api_key="sl_...", name="my-agent")
```

### Instance methods

#### `client.submit(record)` → `RecordAck`

Submit one record.

#### `client.submit_batch(records)` → `BatchAck`

Submit up to 50 records in one request.

#### `client.get_record(record_id)` → `dict`

Fetch a single stored record.

#### `client.get_session(session_id)` → `SessionFetch`

Fetch every record in a session, ordered by `server_ts_utc`.

#### `client.get_trace(opts?)` → `TracePage`

Paginated read of the agent's full trace.

```python
from reasoning_ledger import GetTraceOpts

page = client.get_trace(GetTraceOpts(before=cursor, limit=100))
```

#### `client.new_session(session_id=None)` → `Session`

Create a local session handle. Generates a `session_id` if not supplied.

### Session methods

#### `session.submit(record)` → `RecordAck`

Same as `client.submit`; `session_id` is auto-injected.

#### `session.submit_batch(records)` → `BatchAck`

Same as `client.submit_batch`; `session_id` is auto-injected on each record.

#### `session.id` → `str`

The bound `session_id` (read-only property).

### Utility functions

```python
from reasoning_ledger import is_valid_record_id, new_record_id, now_epoch_ms

new_record_id()              # → fresh UUID v4 string
now_epoch_ms()               # → current epoch milliseconds (int)
is_valid_record_id("...")    # → bool — is the string a valid UUID v4?
```

Use `new_record_id()` when building dependency edges where a child needs to reference an as-yet-unsubmitted record via `upstream_record_id` or `parent_record_id`.

---

## License

MIT
