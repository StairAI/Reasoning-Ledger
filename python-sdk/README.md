# reasoning-ledger

Python SDK for the [Reasoning Ledger](https://github.com/StairAI/Reasoning-Ledger) — an append-only audit trail for AI agent reasoning.

## Install

```sh
pip install reasoning-ledger
```

Requires **Python 3.12+**. Dependencies: `pydantic>=2`, `httpx>=0.27`.

### Upgrading from 0.3

- `endpoint` is required — in `LedgerClientConfig`, `RegisterAgentOpts` and `ResolveAgentOpts`. The `environment` option and the `ENDPOINTS` constant are gone (their built-in hosts never resolved).
- Records use schema 0.4: every record needs `executor` and `record_phase`; `ToolCalling.success` is replaced by `outcome`.
- Prompts, payloads and internal reasoning are content references. Pass raw values and the SDK uploads them (see [Content](#content)); `SIZE_LIMITS` no longer caps them.
- New: `submit_attesting`, `put_content`, `get_content`. `agent_wallet_address` may be `None`.

## Quick start

Every call needs the base URL of your Reasoning Ledger server as `endpoint`. There is no default.

### 1. Register an agent

Agent registration is idempotent on `(owner, name)` — calling it again with the same name returns the existing agent.

```python
import os
from reasoning_ledger import LedgerClient, RegisterAgentOpts

ENDPOINT = os.environ["LEDGER_ENDPOINT"]  # e.g. "https://ledger.example.com"

reg = LedgerClient.register_agent(RegisterAgentOpts(
    api_key=os.environ["STAIRAI_API_KEY"],
    endpoint=ENDPOINT,
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
    endpoint=ENDPOINT,
    name="my-agent",
))
```

### 2. Create a client

```python
from reasoning_ledger import LedgerClient, LedgerClientConfig

client = LedgerClient(LedgerClientConfig(
    api_key=os.environ["STAIRAI_API_KEY"],
    agent_id=agent_id,
    endpoint=ENDPOINT,
))
```

The constructor performs no network call. A missing `endpoint` raises `ValidationError` right away; the API key and agent ID are checked on the first request.

### 3. Open a session and submit records

A `Session` pins a `session_id` so you don't have to pass it on every record. It is purely local sugar — there is no server-side session lifecycle.

Every record states `executor` (`"ai"`, `"det"` or `"human"`: who performed the step) and `record_phase` (`"pre_execution"`, `"concurrent"` or `"post_execution"`: when the record was written relative to the step). The SDK does not default them.

```python
session = client.new_session()  # auto-generates a session_id

# Observing — the trigger that woke your agent
obs = session.submit({
    "behavior": "Observing",
    "executor": "det",
    "record_phase": "post_execution",
    "trigger_source": "sportradar",
    "trigger_type": "signal_trigger",
    "trigger_description": "Match update: Spain vs Morocco, minute 47",
    "trigger_payload_summary": "Spain xG 0.41, possession 62%, shots 8-2",
})

# ToolCalling — payloads may be raw values; the SDK uploads them (see Content)
tool = session.submit({
    "behavior": "ToolCalling",
    "executor": "det",
    "record_phase": "post_execution",
    "upstream_record_id": [obs["record_id"]],
    "tool_meta": {"tool_id": "polymarket_api", "category": "external_api"},
    "description": "Fetch current Spain win odds",
    "input_payload": {"market": "esp_mar"},
    "output_payload": {"spain_win": 0.73},
    "outcome": "success",
})

# Thinking — analysis and decision
session.submit({
    "behavior": "Thinking",
    "executor": "ai",
    "record_phase": "post_execution",
    "upstream_record_id": [tool["record_id"]],
    "prompt": "Given xG 0.41 and odds 0.73, should I adjust the position?",
    "inputs": [{"input_record_id": tool["record_id"], "input_payload": "odds 0.73"}],
    "output_payload": "Hold: confidence 0.81",
})

# Acting — the commitment
session.submit({
    "behavior": "Acting",
    "executor": "det",
    "record_phase": "pre_execution",
    "action_type": "trade",
    "target_system": "broker-api",
    "action_summary": "Hold current Spain win position",
    "parameters": {"symbol": "ESP_WIN", "action": "hold"},
    "dry_run": False,
    "execution_status": "pending",
})
```

### 4. Record a person's decision (Attesting)

`submit_attesting` records a person's disposition of a pending action. It sets `behavior` to `"Attesting"`, `executor` to `"human"` and, unless you pass one, `record_phase` to `"concurrent"`.

```python
session.submit_attesting({
    "operator_id": "reviewer-7",
    "disposition": "approve",            # "approve" | "reject" | "edit"
    "gate_kind": "trade-approval",
    "decision": {"action": "hold"},      # any JSON value
    "written_by": {"component": "review-ui", "credential": "svc-reviewer"},
})
```

A `"reject"` needs a `reason`. Optional fields: `decision`, `reason`, `patch`, `evidence_refs`, `seen_digest`, `policy_snapshot`, `effects` (content; may be a raw value).

### 5. Submit a batch

```python
batch_ack = session.submit_batch([record_a, record_b])

for result in batch_ack["results"]:
    if "code" in result:
        print("Record failed:", result["record_id"], result["code"], result["message"])
```

Up to 50 records per batch. Per-record validation runs locally before the network call; only locally-valid records are sent. Partial server-side failure does not raise — inspect `BatchAck["results"]`.

---

## Content

Raw text never goes into a record. Content positions hold a `ContentRef` — `{"sha256", "bytes", "media_type"}` — pointing at bytes stored in the server's content library:

- `ToolCalling.input_payload`, `ToolCalling.output_payload`
- `Thinking.prompt`, `Thinking.output_payload`, `Thinking.inputs[].input_payload`
- `Reflecting.output_payload`, `Reflecting.inputs[].input_payload`
- `model_invocation.internal_reasoning`
- `Attesting.effects`

**Raw values.** In `submit`, `submit_batch` and the `Session` submit methods, a content position may hold a raw value instead. The SDK uploads it, puts the returned `ContentRef` in its place, then validates and submits:

| Value | Uploaded as |
|---|---|
| `str` | UTF-8, `text/plain; charset=utf-8` |
| `bytes` | as is, `application/octet-stream` |
| any other JSON value (dict, list, number, bool, `None`) | `json.dumps(value, separators=(",", ":"), ensure_ascii=False)`, `application/json` |

A dict whose keys are exactly `sha256` (64 lowercase hex), `bytes` (non-negative int) and `media_type` (str) counts as a `ContentRef` and is left alone. Uploads happen before the record request; a failed upload fails the submit (for a batch, before the batch is posted). To leave an optional position empty, omit the key — `None` is JSON `null` and gets uploaded.

**Direct access.**

```python
ref = client.put_content("full prompt text")                  # text/plain; charset=utf-8
ref = client.put_content(png_bytes, media_type="image/png")    # bytes default to application/octet-stream
data: bytes = client.get_content(ref)                          # or client.get_content(ref["sha256"])
```

Uploads are idempotent by hash: content already stored answers with its existing reference. The server enforces the content size limit (HTTP 413 → `ValidationError`). Reading content that does not exist or was deleted raises `NotFoundError`.

---

## Behavior types

All behaviors extend the base record fields. The `"behavior"` key is the discriminant. Every record requires `executor` and `record_phase`; `outcome`, `duration_ms`, `sources` and `verdict` are optional.

| Behavior | Required fields (beyond base) |
|---|---|
| `"Observing"` | `trigger_source`, `trigger_type`, `trigger_description`, `trigger_payload_summary` |
| `"Planning"` | `goal`, `steps` |
| `"Thinking"` | `prompt`, `inputs`, `output_payload` |
| `"Acting"` | `action_type`, `target_system`, `action_summary`, `parameters`, `dry_run`, `execution_status` (plus `execution_id` when `target_system` is `"public-chain"` and `execution_status` is `"confirmed"`) |
| `"Reflecting"` | `inputs`, `output_payload` |
| `"ToolCalling"` | `tool_meta`, `description`, `input_payload`, `output_payload`, `outcome` |
| `"Attesting"` | `operator_id`, `disposition`, `gate_kind`, `written_by`; `executor` must be `"human"` (plus `reason` when `disposition` is `"reject"`) |
| `"Other"` | `label`, `data` |

### Auto-filled fields

The SDK fills these if you omit them:

| Field | SDK default |
|---|---|
| `record_id` | Fresh UUID v4 |
| `schema_version` | `"0.4"` (bundled constant) |
| `client_ts_utc` | Current epoch milliseconds |
| `agent_id` | From `LedgerClientConfig.agent_id` |

Records read back also carry `server_ts_utc` and `sequence`, the server-assigned order.

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
    print(e.code, e)
```

| Class | `code` | When |
|---|---|---|
| `ValidationError` | `validation_failed` | Local check failed (record never sent), missing `endpoint`, server 400, or content too large (413) |
| `AuthError` | `auth_invalid` | API key rejected |
| `RateLimitError` | `rate_limited` | Server rate-limited the request |
| `NetworkError` | `network_failed` | Request never reached the server after retries |
| `ServerError` | `server_5xx` | Non-retryable 5xx from server |
| `IdempotencyConflictError` | `record_id_conflict` | Same `record_id` submitted with different body |
| `NotFoundError` | `not_found` | Lookup target does not exist (404), or content was deleted (410) |

---

## Configuration

```python
from reasoning_ledger import LedgerClientConfig

config = LedgerClientConfig(
    api_key="sl_...",
    agent_id="uuid-v4",

    # Base URL of your Reasoning Ledger server — required, no default
    endpoint="https://ledger.example.com",

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

The `environment` option and the `ENDPOINTS` constant were removed in 1.0 (their built-in hosts never resolved): pass `endpoint`. A trailing slash is trimmed.

### Custom HTTP transport

Inject any object implementing the `HttpTransport` protocol to intercept or mock network calls. Request bodies are `str` for JSON calls and `bytes` for content uploads; set `body_bytes` on the response to return binary content (the default `HttpxTransport` always does):

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
    endpoint="https://ledger.example.com",
    name="my-agent",
    metadata=AgentMetadata(description="...", tags=["tag1"]),
    wallet=AgentWalletInput(address="0x..."),  # BYOW only
)
```

#### `LedgerClient.resolve_agent_id(opts)` → `str`

Look up an `agent_id` by human-readable name.

```python
opts = ResolveAgentOpts(api_key="sl_...", endpoint="https://ledger.example.com", name="my-agent")
```

### Instance methods

#### `client.submit(record)` → `RecordAck`

Submit one record. Raw values at content positions are uploaded first.

#### `client.submit_attesting(record)` → `RecordAck`

Submit an Attesting record; `behavior`, `executor` and the default `record_phase` are set for you.

#### `client.submit_batch(records)` → `BatchAck`

Submit up to 50 records in one request.

#### `client.put_content(data, media_type=None)` → `ContentRef`

Upload `str` or `bytes` to the content library.

#### `client.get_content(ref)` → `bytes`

Download content by `ContentRef` or sha256.

#### `client.get_record(record_id)` → `dict`

Fetch a single stored record.

#### `client.get_session(session_id)` → `SessionFetch`

Fetch every record in a session, in the order the server received them (`sequence` ascending).

#### `client.get_trace(opts?)` → `TracePage`

Paginated read of the agent's full trace, newest first. Pass the previous page's `next_cursor` as `before`; it is `None` on the last page.

```python
from reasoning_ledger import GetTraceOpts

page = client.get_trace(GetTraceOpts(limit=100))
older = client.get_trace(GetTraceOpts(before=page["next_cursor"], limit=100))
```

#### `client.new_session(session_id=None)` → `Session`

Create a local session handle. Generates a `session_id` if not supplied.

### Session methods

#### `session.submit(record)` / `session.submit_attesting(record)` → `RecordAck`

Same as the client methods; `session_id` is auto-injected.

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
