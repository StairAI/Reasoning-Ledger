"""Tests for Session."""
from __future__ import annotations

import json
from typing import Any

from reasoning_ledger.client import LedgerClient
from reasoning_ledger.types import (
    HttpRequest,
    HttpResponse,
    LedgerClientConfig,
)
from reasoning_ledger.utils import is_valid_record_id

# ---------------------------------------------------------------------------
# Mock transport (same pattern as test_client.py)
# ---------------------------------------------------------------------------


class MockTransport:
    def __init__(self) -> None:
        self.calls: list[HttpRequest] = []
        self._responses: list[HttpResponse] = []

    def enqueue(self, res: HttpResponse) -> None:
        self._responses.append(res)

    def request(self, req: HttpRequest) -> HttpResponse:
        self.calls.append(req)
        if not self._responses:
            msg = "MockTransport: no response queued"
            raise RuntimeError(msg)
        return self._responses.pop(0)


def ok(body: Any) -> HttpResponse:
    return HttpResponse(body=json.dumps(body), headers={}, status=200)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

AGENT_ID = "550e8400-e29b-41d4-a716-446655440000"
API_KEY = f"sl_{'a' * 64}"

RECORD_ACK = {
    "is_duplicate": False,
    "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    "server_ts_utc": 1_700_000_000_123,
    "session_id": "session-001",
}


def make_client(transport: MockTransport) -> LedgerClient:
    return LedgerClient(
        LedgerClientConfig(
            agent_id=AGENT_ID,
            api_key=API_KEY,
            environment="development",
            http_transport=transport,
            retry={"attempts": 1, "backoff_ms": []},
        )
    )


def minimal_input() -> dict[str, Any]:
    return {
        "behavior": "Observing",
        "trigger_description": "A thing happened",
        "trigger_payload_summary": "summary",
        "trigger_source": "webhook",
        "trigger_type": "signal_trigger",
    }


# ---------------------------------------------------------------------------
# Session.id
# ---------------------------------------------------------------------------


class TestSessionId:
    def test_uses_provided_session_id(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        session = client.new_session("my-session")
        assert session.id == "my-session"

    def test_generates_uuid_when_not_provided(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        session = client.new_session()
        assert is_valid_record_id(session.id)

    def test_two_sessions_have_different_ids(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        s1 = client.new_session()
        s2 = client.new_session()
        assert s1.id != s2.id


# ---------------------------------------------------------------------------
# Session.submit
# ---------------------------------------------------------------------------


class TestSessionSubmit:
    def test_injects_session_id_into_record(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        session = client.new_session("injected-session")
        transport.enqueue(ok({**RECORD_ACK, "session_id": "injected-session"}))

        session.submit(minimal_input())

        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["session_id"] == "injected-session"

    def test_session_id_overrides_caller_supplied(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        session = client.new_session("bound-session")
        transport.enqueue(ok({**RECORD_ACK, "session_id": "bound-session"}))

        session.submit({**minimal_input(), "session_id": "caller-supplied"})

        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["session_id"] == "bound-session"

    def test_auto_fills_agent_id_from_config(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        session = client.new_session("s")
        transport.enqueue(ok(RECORD_ACK))

        session.submit(minimal_input())

        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["agent_id"] == AGENT_ID


# ---------------------------------------------------------------------------
# Session.submit_batch
# ---------------------------------------------------------------------------


class TestSessionSubmitBatch:
    def test_injects_session_id_on_every_record(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        session = client.new_session("batch-session")
        batch_ack = {"batch_id": "b1", "results": [RECORD_ACK, RECORD_ACK]}
        transport.enqueue(ok(batch_ack))

        session.submit_batch([minimal_input(), minimal_input()])

        body = json.loads(transport.calls[0]["body"] or "{}")
        for record in body["records"]:
            assert record["session_id"] == "batch-session"

    def test_returns_batch_results_in_order(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        session = client.new_session("s")
        transport.enqueue(
            ok(
                {
                    "batch_id": "bx",
                    "results": [
                        {**RECORD_ACK, "is_duplicate": False},
                        {**RECORD_ACK, "is_duplicate": True},
                    ],
                }
            )
        )

        ack = session.submit_batch([minimal_input(), minimal_input()])
        assert ack["results"][0]["is_duplicate"] is False  # type: ignore[index]
        assert ack["results"][1]["is_duplicate"] is True  # type: ignore[index]
