from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, TypedDict

# ---------------------------------------------------------------------------
# HTTP transport abstraction — used for testing and custom instrumentation.
# ---------------------------------------------------------------------------


class HttpRequest(TypedDict):
    body: str | None
    headers: dict[str, str]
    method: str
    url: str


class HttpResponse(TypedDict):
    body: str
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
    # Default model invocation applied to every submitted record unless the
    # record sets its own model_invocation.
    default_model_invocation: dict[str, Any] | None = None
    # Override base URL. Takes precedence over `environment`.
    endpoint: str | None = None
    # Target environment. Defaults to "production".
    environment: str = "production"
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
    name: str
    metadata: AgentMetadata | None = None
    wallet: AgentWalletInput | None = None


@dataclass(kw_only=True)
class ResolveAgentOpts:
    api_key: str
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


class SessionFetch(TypedDict):
    records: list[dict[str, Any]]
    session_id: str


class TracePage(TypedDict):
    next_cursor: str | None
    records: list[dict[str, Any]]


class AgentRegistration(TypedDict):
    agent_id: str
    agent_wallet_address: str
    created_at: int
    name: str


# ---------------------------------------------------------------------------
# GetTrace options.
# ---------------------------------------------------------------------------


@dataclass(kw_only=True)
class GetTraceOpts:
    """Options for get_trace()."""

    # record_id cursor; returns records older than this record.
    before: str | None = None
    # Page size. Default 100, max 500.
    limit: int | None = None


# ---------------------------------------------------------------------------
# SubmitInput — the caller supplies these; auto-filled fields are optional.
# ---------------------------------------------------------------------------

# Fields auto-filled by the SDK if omitted.
_AUTO_FILLED = frozenset({"agent_id", "client_ts_utc", "record_id", "schema_version"})

# Type alias — callers pass plain dicts; the SDK completes them before sending.
SubmitInput = dict[str, Any]

# GetTrace options field names (kept for documentation clarity).
_GET_TRACE_OPT_FIELDS: list[str] = field(default_factory=list)
