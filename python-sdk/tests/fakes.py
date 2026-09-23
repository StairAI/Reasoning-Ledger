"""Test doubles shared by the unit suites."""

from __future__ import annotations

import hashlib
import json
from typing import Any
from urllib.parse import urlsplit

from reasoning_ledger.client import LedgerClient
from reasoning_ledger.types import HttpRequest, HttpResponse, LedgerClientConfig

ENDPOINT = "https://ledger.test"
AGENT_ID = "550e8400-e29b-41d4-a716-446655440000"
API_KEY = f"sl_{'a' * 64}"
SERVER_TS = 1_700_000_000_123


def ok(body: Any, status: int = 200) -> HttpResponse:
    return HttpResponse(body=json.dumps(body), headers={}, status=status)


def err(status: int, message: str) -> HttpResponse:
    return HttpResponse(body=json.dumps({"message": message}), headers={}, status=status)


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def ack_for(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "is_duplicate": False,
        "record_id": record["record_id"],
        "server_ts_utc": SERVER_TS,
        "session_id": record["session_id"],
    }


class FakeLedgerServer:
    """In-memory stand-in for the api-server's content and record endpoints.

    PUT/GET /v1/content/{sha256} behave like the real content library (hash
    check, 201 on first store, 200 with the stored reference afterwards, 404 for
    unknown content); POST /v1/records and /v1/records/batch accept anything and
    acknowledge it. `put_response` / `post_response` force a response instead.
    """

    def __init__(self) -> None:
        self.calls: list[HttpRequest] = []
        self.content: dict[str, tuple[bytes, str]] = {}
        self.records: list[dict[str, Any]] = []
        self.put_response: HttpResponse | None = None
        self.post_response: HttpResponse | None = None

    # -- HttpTransport -------------------------------------------------------

    def request(self, req: HttpRequest) -> HttpResponse:
        self.calls.append(req)
        path = urlsplit(req["url"]).path
        if path.startswith("/v1/content/"):
            return self._content(req, path.removeprefix("/v1/content/"))
        if req["method"] == "POST" and path in ("/v1/records", "/v1/records/batch"):
            if self.post_response is not None:
                return self.post_response
            body = json.loads(req["body"] or "{}")
            if path == "/v1/records":
                self.records.append(body)
                return ok(ack_for(body))
            self.records.extend(body["records"])
            return ok({"batch_id": "batch-1", "results": [ack_for(r) for r in body["records"]]})
        return err(404, "Not found")

    def _content(self, req: HttpRequest, sha256: str) -> HttpResponse:
        if req["method"] == "PUT":
            if self.put_response is not None:
                return self.put_response
            data = req["body"]
            assert isinstance(data, bytes), "content uploads must send raw bytes"
            if sha256_of(data) != sha256:
                return err(400, f"body hashes to {sha256_of(data)}, not {sha256}")
            status = 200 if sha256 in self.content else 201
            media_type = req["headers"].get("content-type", "application/octet-stream")
            data, media_type = self.content.setdefault(sha256, (data, media_type))
            return ok({"bytes": len(data), "media_type": media_type, "sha256": sha256}, status)
        stored = self.content.get(sha256)
        if stored is None:
            return err(404, "Content not found")
        data, media_type = stored
        return HttpResponse(
            body=data.decode("utf-8", "replace"),
            body_bytes=data,
            headers={"content-type": media_type},
            status=200,
        )

    # -- Inspection ------------------------------------------------------------

    def requests(self, method: str, path_prefix: str = "/v1/") -> list[HttpRequest]:
        return [
            c
            for c in self.calls
            if c["method"] == method and urlsplit(c["url"]).path.startswith(path_prefix)
        ]

    @property
    def uploads(self) -> list[HttpRequest]:
        return self.requests("PUT", "/v1/content/")

    def upload_of(self, data: bytes) -> HttpRequest:
        matches = [u for u in self.uploads if u["body"] == data]
        assert len(matches) == 1, f"expected one upload of {data!r}, got {len(matches)}"
        return matches[0]

    def ref_for(self, data: bytes, media_type: str) -> dict[str, Any]:
        return {"bytes": len(data), "media_type": media_type, "sha256": sha256_of(data)}


def make_client(transport: Any, **overrides: Any) -> LedgerClient:
    config: dict[str, Any] = {
        "agent_id": AGENT_ID,
        "api_key": API_KEY,
        "endpoint": ENDPOINT,
        "http_transport": transport,
        "retry": {"attempts": 1, "backoff_ms": []},
        **overrides,
    }
    return LedgerClient(LedgerClientConfig(**config))
