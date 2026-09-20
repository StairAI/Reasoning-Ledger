from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, NotRequired, Protocol, TypedDict

# ---------------------------------------------------------------------------
# HTTP transport abstraction — used for testing and custom instrumentation.
# ---------------------------------------------------------------------------


class HttpRequest(TypedDict):
    # JSON calls send text; content uploads send raw bytes.
    body: str | bytes | None
    headers: dict[str, str]
    method: str
    url: str


class HttpResponse(TypedDict):
    body: str
    # Raw response bytes. HttpxTransport always fills this; get_content() falls
    # back to `body` encoded as UTF-8 when a custom transport leaves it out.
    body_bytes: NotRequired[bytes]
    headers: dict[str, str]
    status: int


class HttpTransport(Protocol):
    def request(self, req: HttpRequest) -> HttpResponse: ...


# ---------------------------------------------------------------------------
# Retry configuration.
# ---------------------------------------------------------------------------


class RetryConfig(TypedDict):
    """Total attempts (including initial) and per-gap backoff delays in ms."""

    attempts: int
    backoff_ms: list[int]


# ---------------------------------------------------------------------------
# LedgerClientConfig — passed to the LedgerClient constructor.
# ---------------------------------------------------------------------------


@dataclass(kw_only=True)
class LedgerClientConfig:
    """Configuration for LedgerClient."""

    # Owner-level API key (issued out-of-band at owner registration).
    api_key: str
    # UUID v4 agent ID returned by register_agent or resolve_agent_id.
    agent_id: str
    # Base URL of the Reasoning Ledger server, e.g. "https://ledger.example.com".
    # Required; a trailing slash is trimmed.
    endpoint: str
    # Default model invocation applied to every submitted record unless the
    # record sets its own model_invocation.
    default_model_invocation: dict[str, Any] | None = None
    # Override HTTP transport. Defaults to HttpxTransport.
    # Inject a mock here in tests to avoid real network calls.
    http_transport: HttpTransport | None = None
    # Retry configuration.
    retry: RetryConfig | None = None


# ---------------------------------------------------------------------------
# Static method option types.
# ---------------------------------------------------------------------------


@dataclass(kw_only=True)
class AgentWalletInput:
    """Partner wallet for anchoring (v0.1 forward-compat stub)."""

    address: str
    # BYOW signer callback — accepted client-side, never invoked in v0.1.
    signer: Callable[[bytes], bytes] | None = None


@dataclass(kw_only=True)
class AgentMetadata:
    description: str | None = None
    tags: list[str] | None = None
    website: str | None = None


@dataclass(kw_only=True)
class RegisterAgentOpts:
    api_key: str
    # Base URL of the Reasoning Ledger server (see LedgerClientConfig.endpoint).
    endpoint: str
    name: str
    metadata: AgentMetadata | None = None
    wallet: AgentWalletInput | None = None


@dataclass(kw_only=True)
class ResolveAgentOpts:
    api_key: str
    # Base URL of the Reasoning Ledger server (see LedgerClientConfig.endpoint).
    endpoint: str
    name: str


# ---------------------------------------------------------------------------
# Response types (§7.9).
# ---------------------------------------------------------------------------


class RecordAck(TypedDict):
    is_duplicate: bool
    record_id: str
    server_ts_utc: int
    session_id: str


class RecordError(TypedDict):
    code: str
    message: str
    record_id: str


class BatchAck(TypedDict):
    batch_id: str
    results: list[RecordAck | RecordError]


# Stored records come back as plain dicts: the submitted fields plus
# server_ts_utc and `sequence`, the server's total order over all records.


class SessionFetch(TypedDict):
    # In the order the server received them (`sequence` ascending).
    records: list[dict[str, Any]]
    session_id: str


class TracePage(TypedDict):
    # Pass as GetTraceOpts.before for the next page; None on the last page.
    next_cursor: str | None
    # Newest first (`sequence` descending).
    records: list[dict[str, Any]]


class AgentRegistration(TypedDict):
    agent_id: str
    agent_wallet_address: str | None
    created_at: int
    name: str


# ---------------------------------------------------------------------------
# Content library (schema 0.4).
# ---------------------------------------------------------------------------


class ContentRef(TypedDict):
    """Reference to raw content in the content library.

    Raw text never goes into a record: content positions (e.g.
    ToolCalling.input_payload, Thinking.prompt) hold a ContentRef instead.
    """

    # Lowercase hex SHA-256 of the raw bytes.
    sha256: str
    # Size of the raw bytes.
    bytes: int
    media_type: str


# ---------------------------------------------------------------------------
# GetTrace options.
# ---------------------------------------------------------------------------


@dataclass(kw_only=True)
class GetTraceOpts:
    """Options for get_trace()."""

    # Opaque cursor: the `next_cursor` of the previous page. Returns the
    # records that come after it (older ones).
    before: str | None = None
    # Page size. Default 100, max 500.
    limit: int | None = None


# ---------------------------------------------------------------------------
# SubmitInput — the caller supplies these; auto-filled fields are optional.
# ---------------------------------------------------------------------------

# Fields auto-filled by the SDK if omitted.
_AUTO_FILLED = frozenset({"agent_id", "client_ts_utc", "record_id", "schema_version"})

# Type alias — callers pass plain dicts; the SDK completes them before sending.
# Content positions may hold a ContentRef or a raw value (str, bytes or any
# other JSON value), which the SDK uploads first and replaces with its ContentRef.
SubmitInput = dict[str, Any]

# Input for submit_attesting(): an Attesting record without `behavior` and
# `executor`, which the SDK sets ("Attesting", "human"). Requires operator_id,
# disposition, gate_kind and written_by, plus session_id unless submitted
# through a Session. record_phase defaults to "concurrent".
AttestingInput = dict[str, Any]

# GetTrace options field names (kept for documentation clarity).
_GET_TRACE_OPT_FIELDS: list[str] = field(default_factory=list)
