from __future__ import annotations

import json
import uuid
from typing import TYPE_CHECKING, Any

from .constants import ENDPOINTS, SCHEMA_VERSION
from .http import DEFAULT_RETRY, HttpxTransport, build_url, map_http_error, with_retry
from .types import (
    AgentRegistration,
    BatchAck,
    GetTraceOpts,
    HttpTransport,
    LedgerClientConfig,
    RecordAck,
    RecordError,
    RegisterAgentOpts,
    ResolveAgentOpts,
    RetryConfig,
    SessionFetch,
    SubmitInput,
    TracePage,
)
from .utils import new_record_id, now_epoch_ms
from .validate import validate_batch, validate_record

if TYPE_CHECKING:
    from .session import Session

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _resolve_base_url(config: LedgerClientConfig) -> str:
    if config.endpoint is not None:
        return config.endpoint
    return ENDPOINTS.get(config.environment, ENDPOINTS["production"])


def _resolve_retry(config: LedgerClientConfig) -> RetryConfig:
    return config.retry if config.retry is not None else DEFAULT_RETRY


def _complete_record(
    input_record: SubmitInput,
    agent_id: str,
    default_model_invocation: dict[str, Any] | None,
) -> dict[str, Any]:
    record: dict[str, Any] = dict(input_record)
    record.setdefault("agent_id", agent_id)
    record.setdefault("client_ts_utc", now_epoch_ms())
    record.setdefault("record_id", new_record_id())
    record.setdefault("schema_version", SCHEMA_VERSION)
    if record.get("model_invocation") is None and default_model_invocation is not None:
        record["model_invocation"] = default_model_invocation
    return record


def _call_api(
    transport: HttpTransport,
    retry: RetryConfig,
    *,
    api_key: str,
    method: str,
    url: str,
    body: Any = None,
) -> Any:
    headers: dict[str, str] = {
        "content-type": "application/json",
        "x-api-key": api_key,
    }

    def _do() -> Any:
        req_body: str | None = json.dumps(body) if body is not None else None
        res = transport.request(
            {
                "body": req_body,
                "headers": headers,
                "method": method,
                "url": url,
            }
        )
        status = res["status"]
        if status < 200 or status >= 300:
            map_http_error(res)
        return json.loads(res["body"])

    return with_retry(_do, retry)


# ---------------------------------------------------------------------------
# LedgerClient
# ---------------------------------------------------------------------------


class LedgerClient:
    def __init__(self, config: LedgerClientConfig) -> None:
        self._config = config
        self._transport: HttpTransport = config.http_transport or HttpxTransport()
        self._retry = _resolve_retry(config)
        self._base_url = _resolve_base_url(config)

    # -------------------------------------------------------------------------
    # Class methods (static factory equivalents)
    # -------------------------------------------------------------------------

    @classmethod
    def register_agent(
        cls,
        opts: RegisterAgentOpts,
        *,
        _transport: HttpTransport | None = None,
    ) -> AgentRegistration:
        """Register a new agent. Idempotent on (owner, name). See §6.4."""
        transport: HttpTransport = _transport or HttpxTransport()
        body: dict[str, Any] = {"name": opts.name}
        if opts.metadata is not None:
            if opts.metadata.description is not None:
                body["description"] = opts.metadata.description
            if opts.metadata.website is not None:
                body["website"] = opts.metadata.website
            if opts.metadata.tags is not None:
                body["tags"] = opts.metadata.tags
        # signer is a client-side callback — never sent to the server.
        if opts.wallet is not None:
            body["wallet"] = {"address": opts.wallet.address}

        result = _call_api(
            transport,
            DEFAULT_RETRY,
            api_key=opts.api_key,
            method="POST",
            url=f"{ENDPOINTS['production']}/v1/agents",
            body=body,
        )
        return AgentRegistration(**result)  # type: ignore[misc]

    @classmethod
    def resolve_agent_id(
        cls,
        opts: ResolveAgentOpts,
        *,
        _transport: HttpTransport | None = None,
    ) -> str:
        """Resolve an agent's UUID by its human-readable name. See §7.3."""
        transport: HttpTransport = _transport or HttpxTransport()
        url = build_url(f"{ENDPOINTS['production']}/v1/agents", {"name": opts.name})
        result = _call_api(
            transport,
            DEFAULT_RETRY,
            api_key=opts.api_key,
            method="GET",
            url=url,
        )
        return str(result["agent_id"])

    # -------------------------------------------------------------------------
    # Instance methods
    # -------------------------------------------------------------------------

    def submit(self, input_record: SubmitInput) -> RecordAck:
        """Submit a single record with auto-fill. Validates locally first."""
        record = _complete_record(
            input_record,
            self._config.agent_id,
            self._config.default_model_invocation,
        )
        validate_record(record)  # raises ValidationError on failure

        result = _call_api(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="POST",
            url=f"{self._base_url}/v1/records",
            body=record,
        )
        return RecordAck(**result)  # type: ignore[misc]

    def submit_batch(self, inputs: list[SubmitInput]) -> BatchAck:
        """Submit up to 50 records. Per-record errors don't abort the batch."""
        completed = [
            _complete_record(inp, self._config.agent_id, self._config.default_model_invocation)
            for inp in inputs
        ]

        # Raises on batch-level violations (count > 50, total > 1 MB).
        errors = validate_batch(completed)

        valid_records: list[tuple[int, dict[str, Any]]] = []
        results: list[RecordAck | RecordError | None] = [None] * len(inputs)

        for i, (rec, err) in enumerate(zip(completed, errors, strict=True)):
            if err is not None:
                record_id = str(rec.get("record_id", "(unknown)"))
                results[i] = RecordError(
                    code=err.code,
                    message=str(err),
                    record_id=record_id,
                )
            else:
                valid_records.append((i, rec))

        if not valid_records:
            # All records failed local validation; synthesize a batch_id.
            return BatchAck(
                batch_id=str(uuid.uuid4()),
                results=[r for r in results if r is not None],
            )

        server_response = _call_api(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="POST",
            url=f"{self._base_url}/v1/records:batch",
            body={"records": [rec for _, rec in valid_records]},
        )

        # Merge server results back at the correct indices.
        server_results: list[Any] = server_response.get("results", [])
        for j, (orig_idx, _) in enumerate(valid_records):
            if j < len(server_results):
                results[orig_idx] = server_results[j]

        return BatchAck(
            batch_id=str(server_response["batch_id"]),
            results=[r for r in results if r is not None],
        )

    def get_record(self, record_id: str) -> dict[str, Any]:
        """Fetch a single stored record by record_id."""
        return _call_api(  # type: ignore[return-value]
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="GET",
            url=f"{self._base_url}/v1/records/{record_id}",
        )

    def get_session(self, session_id: str) -> SessionFetch:
        """Fetch all records in a session. agent_id is auto-filled."""
        url = build_url(
            f"{self._base_url}/v1/sessions/{session_id}",
            {"agent_id": self._config.agent_id},
        )
        result = _call_api(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="GET",
            url=url,
        )
        return SessionFetch(**result)  # type: ignore[misc]

    def get_trace(self, opts: GetTraceOpts | None = None) -> TracePage:
        """Fetch paginated agent trace, newest-first. agent_id is auto-filled."""
        _opts = opts or GetTraceOpts()
        url = build_url(
            f"{self._base_url}/v1/traces/{self._config.agent_id}",
            {"before": _opts.before, "limit": _opts.limit},
        )
        result = _call_api(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="GET",
            url=url,
        )
        return TracePage(**result)  # type: ignore[misc]

    def new_session(self, session_id: str | None = None) -> Session:
        """Create a Session bound to session_id (or a fresh UUID)."""
        from .session import Session  # local import avoids circular

        return Session(self, session_id)

    # -------------------------------------------------------------------------
    # Internal helpers exposed for Session
    # -------------------------------------------------------------------------

    def _submit(self, input_record: SubmitInput) -> RecordAck:
        return self.submit(input_record)

    def _submit_batch(self, inputs: list[SubmitInput]) -> BatchAck:
        return self.submit_batch(inputs)
