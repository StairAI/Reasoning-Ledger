"""Tests for LedgerClient using a mock HttpTransport."""
from __future__ import annotations

import json
from typing import Any

import pytest

from reasoning_ledger.client import LedgerClient
from reasoning_ledger.errors import AuthError, ServerError, ValidationError
from reasoning_ledger.types import (
    AgentMetadata,
    AgentWalletInput,
    GetTraceOpts,
    HttpRequest,
    HttpResponse,
    HttpTransport,
    LedgerClientConfig,
    RegisterAgentOpts,
    ResolveAgentOpts,
)

# ---------------------------------------------------------------------------
# Mock transport
# ---------------------------------------------------------------------------


class MockTransport:
    """Simple queued mock HttpTransport for tests."""

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


def err(status: int, message: str) -> HttpResponse:
    return HttpResponse(body=json.dumps({"message": message}), headers={}, status=status)


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


def make_config(transport: HttpTransport) -> LedgerClientConfig:
    return LedgerClientConfig(
        agent_id=AGENT_ID,
        api_key=API_KEY,
        environment="development",
        http_transport=transport,
        retry={"attempts": 1, "backoff_ms": []},
    )


def make_client(transport: MockTransport) -> LedgerClient:
    return LedgerClient(make_config(transport))


def minimal_observing_input() -> dict[str, Any]:
    return {
        "behavior": "Observing",
        "session_id": "session-001",
        "trigger_description": "A thing happened",
        "trigger_payload_summary": "summary",
        "trigger_source": "webhook",
        "trigger_type": "signal_trigger",
    }


# ---------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------


class TestSubmit:
    def test_sends_post_with_auto_filled_fields(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(ok(RECORD_ACK))

        ack = client.submit(minimal_observing_input())

        assert ack["record_id"] == RECORD_ACK["record_id"]
        assert len(transport.calls) == 1
        call = transport.calls[0]
        assert call["method"] == "POST"
        assert "/v1/records" in call["url"]

        body = json.loads(call["body"] or "{}")
        assert body["agent_id"] == AGENT_ID
        assert body["schema_version"] == "0.3"
        assert isinstance(body["record_id"], str)
        assert isinstance(body["client_ts_utc"], int)

    def test_sends_x_api_key_header(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(ok(RECORD_ACK))
        client.submit(minimal_observing_input())
        assert transport.calls[0]["headers"]["x-api-key"] == API_KEY

    def test_preserves_caller_supplied_record_id(self) -> None:
        custom_id = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(ok({**RECORD_ACK, "record_id": custom_id}))
        client.submit({**minimal_observing_input(), "record_id": custom_id})
        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["record_id"] == custom_id

    def test_applies_default_model_invocation(self) -> None:
        transport = MockTransport()
        config = LedgerClientConfig(
            agent_id=AGENT_ID,
            api_key=API_KEY,
            environment="development",
            http_transport=transport,
            retry={"attempts": 1, "backoff_ms": []},
            default_model_invocation={"model_name": "claude-opus-4", "provider": "anthropic"},
        )
        client = LedgerClient(config)
        transport.enqueue(ok(RECORD_ACK))
        client.submit(minimal_observing_input())
        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["model_invocation"]["provider"] == "anthropic"

    def test_record_model_invocation_overrides_default(self) -> None:
        transport = MockTransport()
        config = LedgerClientConfig(
            agent_id=AGENT_ID,
            api_key=API_KEY,
            environment="development",
            http_transport=transport,
            retry={"attempts": 1, "backoff_ms": []},
            default_model_invocation={"model_name": "claude-opus-4", "provider": "anthropic"},
        )
        client = LedgerClient(config)
        transport.enqueue(ok(RECORD_ACK))
        client.submit(
            {
                **minimal_observing_input(),
                "model_invocation": {"model_name": "gpt-4o", "provider": "openai"},
            }
        )
        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["model_invocation"]["provider"] == "openai"

    def test_invalid_record_raises_before_http(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        with pytest.raises(ValidationError):
            client.submit({"behavior": "Observing", "session_id": "s"})
        assert len(transport.calls) == 0

    def test_raises_auth_error_on_401(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(err(401, "Unauthorized"))
        with pytest.raises(AuthError):
            client.submit(minimal_observing_input())

    def test_raises_server_error_on_500(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(err(500, "Internal Server Error"))
        with pytest.raises(ServerError):
            client.submit(minimal_observing_input())

    def test_is_duplicate_true_on_duplicate(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(ok({**RECORD_ACK, "is_duplicate": True}))
        ack = client.submit(minimal_observing_input())
        assert ack["is_duplicate"] is True


# ---------------------------------------------------------------------------
# submit_batch
# ---------------------------------------------------------------------------


class TestSubmitBatch:
    def test_sends_post_batch_with_records_array(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        batch_response = {"batch_id": "batch-123", "results": [RECORD_ACK, RECORD_ACK]}
        transport.enqueue(ok(batch_response))
        ack = client.submit_batch([minimal_observing_input(), minimal_observing_input()])
        assert ack["batch_id"] == "batch-123"
        assert len(ack["results"]) == 2
        body = json.loads(transport.calls[0]["body"] or "{}")
        assert len(body["records"]) == 2

    def test_invalid_records_produce_record_error_without_http_for_valid(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(ok({"batch_id": "batch-xyz", "results": [RECORD_ACK]}))

        invalid: dict[str, Any] = {"behavior": "Observing", "session_id": "s"}
        ack = client.submit_batch([minimal_observing_input(), invalid])

        assert len(ack["results"]) == 2
        # First (valid) → RecordAck from server
        assert ack["results"][0].get("is_duplicate") is False  # type: ignore[union-attr]
        # Second (invalid) → synthetic RecordError
        assert ack["results"][1].get("code") == "validation_failed"  # type: ignore[union-attr]

    def test_all_invalid_returns_synthetic_batch_id_no_http(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        invalid: dict[str, Any] = {"behavior": "Observing", "session_id": "s"}
        ack = client.submit_batch([invalid])
        assert isinstance(ack["batch_id"], str)
        assert len(transport.calls) == 0
        assert ack["results"][0].get("code") == "validation_failed"  # type: ignore[union-attr]

    def test_raises_validation_error_for_batch_over_50(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        records = [minimal_observing_input() for _ in range(51)]
        with pytest.raises(ValidationError):
            client.submit_batch(records)
        assert len(transport.calls) == 0


# ---------------------------------------------------------------------------
# get_record
# ---------------------------------------------------------------------------


class TestGetRecord:
    def test_sends_get_records_id(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        record_id = "6ba7b810-9dad-41d1-80b4-00c04fd430c8"
        transport.enqueue(ok({"behavior": "Observing", "record_id": record_id}))
        record = client.get_record(record_id)
        assert record["record_id"] == record_id
        assert transport.calls[0]["method"] == "GET"
        assert f"/v1/records/{record_id}" in transport.calls[0]["url"]


# ---------------------------------------------------------------------------
# get_session
# ---------------------------------------------------------------------------


class TestGetSession:
    def test_sends_get_with_agent_id_param(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(ok({"records": [], "session_id": "session-001"}))
        client.get_session("session-001")
        url = transport.calls[0]["url"]
        assert "/v1/sessions/session-001" in url
        assert f"agent_id={AGENT_ID}" in url


# ---------------------------------------------------------------------------
# get_trace
# ---------------------------------------------------------------------------


class TestGetTrace:
    def test_sends_get_traces_agent_id(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        transport.enqueue(ok({"next_cursor": None, "records": []}))
        client.get_trace()
        url = transport.calls[0]["url"]
        assert f"/v1/traces/{AGENT_ID}" in url
        assert transport.calls[0]["method"] == "GET"

    def test_includes_before_and_limit_params(self) -> None:
        transport = MockTransport()
        client = make_client(transport)
        cursor_id = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
        transport.enqueue(ok({"next_cursor": None, "records": []}))
        client.get_trace(GetTraceOpts(before=cursor_id, limit=25))
        url = transport.calls[0]["url"]
        assert f"before={cursor_id}" in url
        assert "limit=25" in url


# ---------------------------------------------------------------------------
# Retry behaviour
# ---------------------------------------------------------------------------


class TestRetry:
    def test_retries_on_server_error_up_to_attempts(self) -> None:
        transport = MockTransport()
        client = LedgerClient(
            LedgerClientConfig(
                agent_id=AGENT_ID,
                api_key=API_KEY,
                environment="development",
                http_transport=transport,
                retry={"attempts": 3, "backoff_ms": [0, 0]},
            )
        )
        # Two 500s then success.
        transport.enqueue(err(500, "oops"))
        transport.enqueue(err(500, "oops"))
        transport.enqueue(ok(RECORD_ACK))
        ack = client.submit(minimal_observing_input())
        assert ack["record_id"] == RECORD_ACK["record_id"]
        assert len(transport.calls) == 3

    def test_raises_after_exhausting_attempts(self) -> None:
        transport = MockTransport()
        client = LedgerClient(
            LedgerClientConfig(
                agent_id=AGENT_ID,
                api_key=API_KEY,
                environment="development",
                http_transport=transport,
                retry={"attempts": 2, "backoff_ms": [0]},
            )
        )
        transport.enqueue(err(500, "oops"))
        transport.enqueue(err(500, "oops"))
        with pytest.raises(ServerError):
            client.submit(minimal_observing_input())

    def test_does_not_retry_on_auth_error(self) -> None:
        transport = MockTransport()
        client = LedgerClient(
            LedgerClientConfig(
                agent_id=AGENT_ID,
                api_key=API_KEY,
                environment="development",
                http_transport=transport,
                retry={"attempts": 3, "backoff_ms": [0, 0]},
            )
        )
        transport.enqueue(err(401, "Unauthorized"))
        with pytest.raises(AuthError):
            client.submit(minimal_observing_input())
        # Only one call — auth errors are not retried.
        assert len(transport.calls) == 1

    def test_retries_on_network_error(self) -> None:
        from reasoning_ledger.errors import NetworkError as _NE

        class FailOnceThenOkTransport:
            def __init__(self) -> None:
                self.calls = 0

            def request(self, req: HttpRequest) -> HttpResponse:
                self.calls += 1
                if self.calls < 3:
                    raise _NE("timeout")
                return ok(RECORD_ACK)

        transport2 = FailOnceThenOkTransport()
        client = LedgerClient(
            LedgerClientConfig(
                agent_id=AGENT_ID,
                api_key=API_KEY,
                environment="development",
                http_transport=transport2,
                retry={"attempts": 3, "backoff_ms": [0, 0]},
            )
        )
        ack = client.submit(minimal_observing_input())
        assert ack["record_id"] == RECORD_ACK["record_id"]


# ---------------------------------------------------------------------------
# register_agent / resolve_agent_id (class methods)
# ---------------------------------------------------------------------------


class TestRegisterAgent:
    def test_sends_post_agents_returns_registration(self) -> None:
        transport = MockTransport()
        registration = {
            "agent_id": AGENT_ID,
            "agent_wallet_address": f"0x{'b' * 64}",
            "created_at": 1_700_000_000_000,
            "name": "my-agent",
        }
        transport.enqueue(ok(registration))

        result = LedgerClient.register_agent(
            RegisterAgentOpts(api_key=API_KEY, name="my-agent"),
            _transport=transport,
        )
        assert result["agent_id"] == AGENT_ID
        assert transport.calls[0]["method"] == "POST"
        assert "/v1/agents" in transport.calls[0]["url"]

    def test_includes_wallet_address_in_body(self) -> None:
        transport = MockTransport()
        stub = {"agent_id": AGENT_ID, "agent_wallet_address": "0x1", "created_at": 0, "name": "n"}
        transport.enqueue(ok(stub))
        LedgerClient.register_agent(
            RegisterAgentOpts(
                api_key=API_KEY,
                name="n",
                wallet=AgentWalletInput(address="0xABC"),
            ),
            _transport=transport,
        )
        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["wallet"]["address"] == "0xABC"

    def test_does_not_include_signer_in_body(self) -> None:
        transport = MockTransport()
        stub = {"agent_id": AGENT_ID, "agent_wallet_address": "0x1", "created_at": 0, "name": "n"}
        transport.enqueue(ok(stub))
        LedgerClient.register_agent(
            RegisterAgentOpts(
                api_key=API_KEY,
                name="n",
                wallet=AgentWalletInput(address="0xABC", signer=lambda b: b),
            ),
            _transport=transport,
        )
        body = json.loads(transport.calls[0]["body"] or "{}")
        assert "signer" not in body.get("wallet", {})

    def test_includes_metadata_fields_in_body(self) -> None:
        transport = MockTransport()
        stub = {"agent_id": AGENT_ID, "agent_wallet_address": "0x1", "created_at": 0, "name": "n"}
        transport.enqueue(ok(stub))
        LedgerClient.register_agent(
            RegisterAgentOpts(
                api_key=API_KEY,
                name="n",
                metadata=AgentMetadata(description="my bot", tags=["ai"], website="https://example.com"),
            ),
            _transport=transport,
        )
        body = json.loads(transport.calls[0]["body"] or "{}")
        assert body["description"] == "my bot"
        assert body["tags"] == ["ai"]
        assert body["website"] == "https://example.com"


class TestResolveAgentId:
    def test_sends_get_agents_name_param_returns_agent_id(self) -> None:
        transport = MockTransport()
        transport.enqueue(ok({"agent_id": AGENT_ID, "name": "my-agent"}))

        agent_id = LedgerClient.resolve_agent_id(
            ResolveAgentOpts(api_key=API_KEY, name="my-agent"),
            _transport=transport,
        )
        assert agent_id == AGENT_ID
        assert transport.calls[0]["method"] == "GET"
        assert "name=my-agent" in transport.calls[0]["url"]
