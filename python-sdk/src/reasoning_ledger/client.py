from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .constants import SCHEMA_VERSION
from .content import (
    content_slots,
    encode_content,
    encode_text_or_bytes,
    is_content_ref,
    is_sha256_hex,
    sha256_hex,
)
from .errors import ValidationError
from .http import DEFAULT_RETRY, HttpxTransport, build_url, map_http_error, with_retry
from .types import (
    AgentRegistration,
    AttestingInput,
    BatchAck,
    ContentRef,
    GetTraceOpts,
    HttpResponse,
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


def _resolve_base_url(endpoint: object) -> str:
    """The server base URL without a trailing slash. Raises ValidationError when missing."""
    base_url = endpoint.strip().rstrip("/") if isinstance(endpoint, str) else ""
    if not base_url:
        raise ValidationError(
            "endpoint is required: the base URL of the Reasoning Ledger server",
            {"field": "endpoint", "reason": "required"},
        )
    return base_url


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


def _attesting_record(input_record: AttestingInput) -> dict[str, Any]:
    record: dict[str, Any] = {**input_record, "behavior": "Attesting", "executor": "human"}
    if record.get("record_phase") is None:
        record["record_phase"] = "concurrent"
    return record


@dataclass(frozen=True, slots=True)
class _Upload:
    """A raw value from a content position, encoded and waiting to be uploaded."""

    container: dict[str, Any]
    key: str
    data: bytes
    media_type: str
    sha256: str


def _plan_uploads(record: dict[str, Any]) -> list[_Upload]:
    """Put in every content position holding a raw value the ContentRef that the
    upload will produce (computed locally, so the record can be validated before
    any request), and return the uploads that make those references real."""
    uploads: list[_Upload] = []
    for container, key, path in content_slots(record):
        value = container[key]
        if is_content_ref(value):
            continue
        data, media_type = encode_content(value, path)
        digest = sha256_hex(data)
        container[key] = ContentRef(sha256=digest, bytes=len(data), media_type=media_type)
        uploads.append(_Upload(container, key, data, media_type, digest))
    return uploads


def _send(
    transport: HttpTransport,
    retry: RetryConfig,
    *,
    api_key: str,
    method: str,
    url: str,
    body: str | bytes | None = None,
    content_type: str | None = None,
) -> HttpResponse:
    headers: dict[str, str] = {"x-api-key": api_key}
    if content_type is not None:
        headers["content-type"] = content_type

    def _do() -> HttpResponse:
        res = transport.request(
            {
                "body": body,
                "headers": headers,
                "method": method,
                "url": url,
            }
        )
        status = res["status"]
        if status < 200 or status >= 300:
            map_http_error(res)
        return res

    return with_retry(_do, retry)


def _call_api(
    transport: HttpTransport,
    retry: RetryConfig,
    *,
    api_key: str,
    method: str,
    url: str,
    body: Any = None,
) -> Any:
    res = _send(
        transport,
        retry,
        api_key=api_key,
        method=method,
        url=url,
        body=json.dumps(body) if body is not None else None,
        content_type="application/json",
    )
    return json.loads(res["body"])


# ---------------------------------------------------------------------------
# LedgerClient
# ---------------------------------------------------------------------------


class LedgerClient:
    def __init__(self, config: LedgerClientConfig) -> None:
        self._config = config
        self._base_url = _resolve_base_url(config.endpoint)
        self._transport: HttpTransport = config.http_transport or HttpxTransport()
        self._retry = _resolve_retry(config)

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
        base_url = _resolve_base_url(opts.endpoint)
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
            url=f"{base_url}/v1/agents",
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
        base_url = _resolve_base_url(opts.endpoint)
        transport: HttpTransport = _transport or HttpxTransport()
        url = build_url(f"{base_url}/v1/agents", {"name": opts.name})
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
        """Submit a single record with auto-fill.

        Raw values at content positions are uploaded first and replaced by their
        ContentRef. The record is validated locally before any request.
        """
        record = _complete_record(
            input_record,
            self._config.agent_id,
            self._config.default_model_invocation,
        )
        uploads = _plan_uploads(record)
        validate_record(record)  # raises ValidationError on failure
        self._upload(uploads)

        result = _call_api(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="POST",
            url=f"{self._base_url}/v1/records",
            body=record,
        )
        return RecordAck(**result)  # type: ignore[misc]

    def submit_attesting(self, input_record: AttestingInput) -> RecordAck:
        """Submit an Attesting record: a person's disposition of a pending action.

        Sets behavior "Attesting", executor "human" and, unless given,
        record_phase "concurrent". `effects` may be a raw value (uploaded).
        """
        return self.submit(_attesting_record(input_record))

    def submit_batch(self, inputs: list[SubmitInput]) -> BatchAck:
        """Submit up to 50 records. Per-record errors don't abort the batch.

        Raw content of the locally valid records is uploaded before the batch
        is posted; a failed upload raises and nothing is posted.
        """
        completed = [
            _complete_record(inp, self._config.agent_id, self._config.default_model_invocation)
            for inp in inputs
        ]
        planned: list[list[_Upload]] = []
        for index, rec in enumerate(completed):
            try:
                planned.append(_plan_uploads(rec))
            except ValidationError as exc:
                raise ValidationError(f"records[{index}]: {exc}", exc.details) from exc

        # Raises on batch-level violations (count > 50, total > 1 MB).
        errors = validate_batch(completed)

        valid_records: list[tuple[int, dict[str, Any]]] = []
        uploads: list[_Upload] = []
        results: list[RecordAck | RecordError | None] = [None] * len(inputs)

        for i, (rec, err, rec_uploads) in enumerate(zip(completed, errors, planned, strict=True)):
            if err is not None:
                record_id = str(rec.get("record_id", "(unknown)"))
                results[i] = RecordError(
                    code=err.code,
                    message=str(err),
                    record_id=record_id,
                )
            else:
                valid_records.append((i, rec))
                uploads.extend(rec_uploads)

        if not valid_records:
            # All records failed local validation; synthesize a batch_id.
            return BatchAck(
                batch_id=str(uuid.uuid4()),
                results=[r for r in results if r is not None],
            )

        self._upload(uploads)

        server_response = _call_api(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="POST",
            url=f"{self._base_url}/v1/records/batch",
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

    def put_content(self, data: str | bytes, media_type: str | None = None) -> ContentRef:
        """Upload content to the content library and return its ContentRef.

        str is sent UTF-8 encoded (default media type "text/plain; charset=utf-8"),
        bytes as they are (default "application/octet-stream"). Idempotent:
        content already stored answers with its existing reference.
        """
        encoded = encode_text_or_bytes(data, "data")
        if encoded is None:
            raise ValidationError(
                f"put_content() takes str or bytes, not {type(data).__name__}",
                {"field": "data", "reason": "invalid type"},
            )
        body, default_media_type = encoded
        return self._put_content(body, media_type or default_media_type, sha256_hex(body))

    def get_content(self, ref: ContentRef | str) -> bytes:
        """Download content by its ContentRef or sha256.

        Raises NotFoundError when this owner holds no such content or it was deleted.
        """
        if isinstance(ref, str):
            digest: object = ref
        else:
            digest = ref.get("sha256") if isinstance(ref, dict) else None
        if not is_sha256_hex(digest):
            raise ValidationError(
                "get_content() takes a ContentRef or a sha256 of 64 lowercase hex characters",
                {"field": "sha256", "reason": "invalid"},
            )
        res = _send(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="GET",
            url=f"{self._base_url}/v1/content/{digest}",
        )
        raw = res.get("body_bytes")
        return raw if raw is not None else res["body"].encode("utf-8")

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
        """Fetch all records in a session, in sequence order. agent_id is auto-filled."""
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
        """Fetch paginated agent trace, newest-first. agent_id is auto-filled.

        Pass the previous page's next_cursor as GetTraceOpts.before for the next page.
        """
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
    # Content uploads
    # -------------------------------------------------------------------------

    def _put_content(self, data: bytes, media_type: str, digest: str) -> ContentRef:
        res = _send(
            self._transport,
            self._retry,
            api_key=self._config.api_key,
            method="PUT",
            url=f"{self._base_url}/v1/content/{digest}",
            body=data,
            content_type=media_type,
        )
        stored = json.loads(res["body"])
        return ContentRef(
            sha256=stored["sha256"],
            bytes=stored["bytes"],
            media_type=stored["media_type"],
        )

    def _upload(self, uploads: list[_Upload]) -> None:
        """Upload planned content, each distinct piece once, and put the
        references the server returns in place."""
        refs: dict[tuple[str, str], ContentRef] = {}
        for upload in uploads:
            key = (upload.sha256, upload.media_type)
            if key not in refs:
                refs[key] = self._put_content(upload.data, upload.media_type, upload.sha256)
            upload.container[upload.key] = refs[key].copy()

    # -------------------------------------------------------------------------
    # Internal helpers exposed for Session
    # -------------------------------------------------------------------------

    def _submit(self, input_record: SubmitInput) -> RecordAck:
        return self.submit(input_record)

    def _submit_attesting(self, input_record: AttestingInput) -> RecordAck:
        return self.submit_attesting(input_record)

    def _submit_batch(self, inputs: list[SubmitInput]) -> BatchAck:
        return self.submit_batch(inputs)
