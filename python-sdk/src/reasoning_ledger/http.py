from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any

import httpx

from .errors import (
    AuthError,
    IdempotencyConflictError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ServerError,
    ValidationError,
)
from .types import HttpRequest, HttpResponse, RetryConfig

# ---------------------------------------------------------------------------
# Default retry configuration (§7.5 / §8.3).
# ---------------------------------------------------------------------------

DEFAULT_RETRY: RetryConfig = {
    "attempts": 3,
    "backoff_ms": [500, 1000, 2000],
}

# ---------------------------------------------------------------------------
# HttpxTransport — default HttpTransport backed by httpx (sync).
# ---------------------------------------------------------------------------


class HttpxTransport:
    """Synchronous HTTP transport backed by httpx."""

    def request(self, req: HttpRequest) -> HttpResponse:
        try:
            res = httpx.request(
                method=req["method"],
                url=req["url"],
                content=req.get("body"),
                headers=req["headers"],
            )
        except httpx.TransportError as exc:
            raise NetworkError(f"Network error: {exc}") from exc

        headers: dict[str, str] = dict(res.headers)
        return HttpResponse(
            body=res.text,
            headers=headers,
            status=res.status_code,
        )


# ---------------------------------------------------------------------------
# parse_error_body — extract a human-readable message from the server body.
# ---------------------------------------------------------------------------


def _parse_error_body(body: str) -> tuple[str, dict[str, object] | None]:
    try:
        parsed: Any = json.loads(body)
        if isinstance(parsed, dict):
            raw_msg = parsed.get("message")
            message = raw_msg if isinstance(raw_msg, str) else "Server returned error"
            raw_details = parsed.get("details")
            details: dict[str, object] | None = (
                raw_details if isinstance(raw_details, dict) else None
            )
            return message, details
    except (json.JSONDecodeError, ValueError):
        pass
    return (body[:256] if body else "Unknown error"), None


# ---------------------------------------------------------------------------
# map_http_error — convert a non-2xx response to the appropriate LedgerError.
# ---------------------------------------------------------------------------


def map_http_error(res: HttpResponse) -> None:
    """Raise the appropriate LedgerError for a non-2xx response."""
    message, details = _parse_error_body(res["body"])
    status = res["status"]

    if status == 400:
        raise ValidationError(message, details)
    if status == 401:
        raise AuthError(message, details)
    if status == 404:
        raise NotFoundError(message, details)
    if status == 409:
        raise IdempotencyConflictError(message, details)
    if status == 429:
        retry_after_raw = res["headers"].get("retry-after")
        extra: dict[str, object] | None = None
        if retry_after_raw is not None:
            retry_after_ms = int(float(retry_after_raw) * 1000)
            extra = {"retry_after_ms": retry_after_ms}
        merged = {**(details or {}), **(extra or {})}
        raise RateLimitError(message, merged or None)
    if status >= 500:
        merged_5xx = {**(details or {}), "status": status}
        raise ServerError(message, merged_5xx)
    merged_other = {**(details or {}), "status": status}
    raise ServerError(f"Unexpected HTTP status {status}: {message}", merged_other)


# ---------------------------------------------------------------------------
# should_retry — only retry on transient errors (NetworkError + ServerError).
# ---------------------------------------------------------------------------


def should_retry(err: object) -> bool:
    return isinstance(err, NetworkError | ServerError)


# ---------------------------------------------------------------------------
# with_retry — execute fn, retrying on transient errors with backoff.
# ---------------------------------------------------------------------------


def with_retry[T](fn: Callable[[], T], config: RetryConfig = DEFAULT_RETRY) -> T:
    """Call fn() up to config['attempts'] times, sleeping between failures."""
    attempts = config["attempts"]
    backoff_ms = config["backoff_ms"]
    last_err: Exception = RuntimeError("with_retry: exhausted all attempts")

    for attempt in range(attempts):
        try:
            return fn()
        except Exception as exc:
            if should_retry(exc):
                last_err = exc
                if attempt < attempts - 1:
                    idx = min(attempt, len(backoff_ms) - 1)
                    delay_ms = backoff_ms[idx] if backoff_ms else 500
                    time.sleep(delay_ms / 1000.0)
            else:
                raise

    raise last_err


# ---------------------------------------------------------------------------
# build_url — append query string parameters to a base URL.
# Undefined (None) values are omitted.
# ---------------------------------------------------------------------------


def build_url(base: str, params: dict[str, str | int | None]) -> str:
    parts: list[str] = []
    for key, value in params.items():
        if value is not None:
            parts.append(f"{key}={value}")
    if not parts:
        return base
    return f"{base}?{'&'.join(parts)}"
