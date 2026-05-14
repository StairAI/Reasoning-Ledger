"""End-to-end lifecycle of the Python SDK against staging-api.stair-ai.com."""

from __future__ import annotations

import json

import pytest

from reasoning_ledger import (
    AuthError,
    LedgerClient,
    LedgerClientConfig,
    NotFoundError,
    ResolveAgentOpts,
    new_record_id,
)

from .conftest import requires_staging
from .staging_transport import StagingEnv, StagingTransport

pytestmark = [requires_staging]


class TestAgentLifecycle:
    def test_register_agent_returns_uuid(self, agent_id: str) -> None:
        # UUID v4 shape — exact format checked once; rest of the suite trusts it.
        assert len(agent_id) == 36
        assert agent_id.count("-") == 4

    def test_resolve_agent_id_round_trips(
        self,
        staging_env: StagingEnv,
        staging_transport: StagingTransport,
        agent_id: str,
    ) -> None:
        resolved = LedgerClient.resolve_agent_id(
            ResolveAgentOpts(api_key=staging_env.api_key, name=staging_env.agent_name),
            _transport=staging_transport,
        )
        assert resolved == agent_id


class TestSubmit:
    def test_full_decision_cycle(
        self,
        client: LedgerClient,
        session_id: str,
        submitted_record_ids: list[str],
    ) -> None:
        session = client.new_session(session_id)

        observing_id = new_record_id()
        ack_obs = session.submit(
            {
                "behavior": "Observing",
                "record_id": observing_id,
                "trigger_description": "Staging probe triggered from integration test",
                "trigger_payload_summary": "probe=1",
                "trigger_source": "integration-tests",
                "trigger_type": "signal_trigger",
            }
        )
        assert ack_obs["session_id"] == session_id
        assert ack_obs["is_duplicate"] is False
        submitted_record_ids.append(ack_obs["record_id"])

        ack_tc = session.submit(
            {
                "behavior": "ToolCalling",
                "tool_meta": {"tool_id": "probe-tool", "category": "external_api"},
                "description": "fetch baseline",
                "input_payload": json.dumps({"query": "baseline"}),
                "output_payload": json.dumps({"value": 42}),
                "success": True,
                "upstream_record_id": [observing_id],
            }
        )
        submitted_record_ids.append(ack_tc["record_id"])

        ack_think = session.submit(
            {
                "behavior": "Thinking",
                "prompt": "Given the baseline, do we act?",
                "inputs": [],
                "output_payload": json.dumps({"decision": "hold"}),
            }
        )
        submitted_record_ids.append(ack_think["record_id"])

        ack_act = session.submit(
            {
                "behavior": "Acting",
                "action_type": "noop",
                "target_system": "integration-tests",
                "action_summary": "no-op: integration test",
                "parameters": {"target": "none"},
                "dry_run": True,
                "execution_status": "confirmed",
            }
        )
        submitted_record_ids.append(ack_act["record_id"])

    def test_submit_is_idempotent_on_record_id(
        self,
        client: LedgerClient,
        session_id: str,
        submitted_record_ids: list[str],
    ) -> None:
        rid = new_record_id()
        session = client.new_session(session_id)
        base = {
            "behavior": "Other",
            "label": "idempotency-probe",
            "data": {"iteration": 1},
            "record_id": rid,
        }

        first = session.submit(base)
        assert first["is_duplicate"] is False

        second = session.submit(base)
        assert second["is_duplicate"] is True
        assert second["record_id"] == rid

        submitted_record_ids.append(rid)

    def test_submit_batch(
        self,
        client: LedgerClient,
        session_id: str,
        submitted_record_ids: list[str],
    ) -> None:
        session = client.new_session(session_id)
        ack = session.submit_batch(
            [
                {"behavior": "Other", "label": "py-batch-0", "data": {"i": 0}},
                {"behavior": "Other", "label": "py-batch-1", "data": {"i": 1}},
                {"behavior": "Other", "label": "py-batch-2", "data": {"i": 2}},
            ]
        )
        assert ack["batch_id"]
        assert len(ack["results"]) == 3
        for r in ack["results"]:
            assert "code" not in r
            submitted_record_ids.append(r["record_id"])  # type: ignore[typeddict-item]


class TestFetch:
    def test_get_record_returns_submitted(
        self,
        client: LedgerClient,
        agent_id: str,
        session_id: str,
        submitted_record_ids: list[str],
    ) -> None:
        assert submitted_record_ids, "lifecycle tests must run first to seed records"
        rid = submitted_record_ids[0]
        record = client.get_record(rid)
        assert record["record_id"] == rid
        assert record["agent_id"] == agent_id
        assert record["session_id"] == session_id

    def test_get_session_covers_all_submissions(
        self,
        client: LedgerClient,
        session_id: str,
        submitted_record_ids: list[str],
    ) -> None:
        fetched = client.get_session(session_id)
        assert fetched["session_id"] == session_id
        ids = {r["record_id"] for r in fetched["records"]}
        for rid in submitted_record_ids:
            assert rid in ids

        server_ts = [int(r["server_ts_utc"]) for r in fetched["records"]]
        assert server_ts == sorted(server_ts), "session records must be ascending by server_ts_utc"

    def test_get_trace_is_newest_first_and_paginates(self, client: LedgerClient) -> None:
        page = client.get_trace()
        assert isinstance(page["records"], list)
        ts = [int(r["server_ts_utc"]) for r in page["records"]]
        assert ts == sorted(ts, reverse=True)

        if page["next_cursor"] is not None:
            from reasoning_ledger import GetTraceOpts

            page2 = client.get_trace(GetTraceOpts(before=page["next_cursor"], limit=50))
            assert isinstance(page2["records"], list)


class TestErrors:
    def test_get_record_missing_raises_not_found(self, client: LedgerClient) -> None:
        with pytest.raises(NotFoundError):
            client.get_record(new_record_id())

    def test_bad_api_key_raises_auth_error(
        self,
        staging_env: StagingEnv,
        staging_transport: StagingTransport,
        agent_id: str,
    ) -> None:
        bad = LedgerClient(
            LedgerClientConfig(
                agent_id=agent_id,
                api_key=f"sl_{'0' * 64}",
                endpoint=staging_env.base_url,
                http_transport=staging_transport,
                retry={"attempts": 1, "backoff_ms": []},
            )
        )
        with pytest.raises(AuthError):
            bad.get_trace()
