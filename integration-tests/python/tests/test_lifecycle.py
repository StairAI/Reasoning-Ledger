"""End-to-end lifecycle of the Python SDK against a running api-server."""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

import pytest

from reasoning_ledger import (
    AuthError,
    GetTraceOpts,
    HttpRequest,
    HttpResponse,
    LedgerClient,
    LedgerClientConfig,
    NotFoundError,
    RecordAck,
    ResolveAgentOpts,
    ValidationError,
    new_record_id,
    now_epoch_ms,
)

from .conftest import requires_staging
from .staging_env import StagingEnv

pytestmark = [requires_staging]

TEXT = "text/plain; charset=utf-8"
WRITTEN_BY = {"component": "integration-tests/python", "credential": "owner-api-key"}


def fresh_session_id(label: str) -> str:
    return f"it-py-{label}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"


class NoNetwork:
    """Transport that fails the test if the SDK sends anything."""

    def request(self, req: HttpRequest) -> HttpResponse:
        msg = f"unexpected request: {req['method']} {req['url']}"
        raise AssertionError(msg)


@dataclass(frozen=True)
class Cycle:
    session_id: str
    # record_id per step, in write order.
    ids: dict[str, str]
    acks: dict[str, RecordAck]
    tool_input: dict[str, Any]
    prompt: str


@pytest.fixture(scope="module")
def cycle(client: LedgerClient) -> Cycle:
    """Write one full decision cycle in its own session; the tests read it back."""
    session = client.new_session(fresh_session_id("cycle"))
    steps = ("observing", "toolcalling", "thinking", "acting", "attesting")
    ids = {step: new_record_id() for step in steps}
    tool_input = {"query": "baseline", "n": 1}
    prompt = f"Given the baseline, do we act? (run {ids['thinking']})"
    acks: dict[str, RecordAck] = {}

    acks["observing"] = session.submit(
        {
            "behavior": "Observing",
            "record_id": ids["observing"],
            "executor": "det",
            "record_phase": "post_execution",
            "trigger_source": "integration-tests",
            "trigger_type": "signal_trigger",
            "trigger_description": "Probe triggered from the Python integration suite",
            "trigger_payload_summary": "probe=1",
        }
    )
    acks["toolcalling"] = session.submit(
        {
            "behavior": "ToolCalling",
            "record_id": ids["toolcalling"],
            "upstream_record_id": [ids["observing"]],
            "executor": "det",
            "record_phase": "post_execution",
            "tool_meta": {"name": "baseline-probe"},
            "description": "fetch baseline",
            # Objects: uploaded as application/json content.
            "input_payload": tool_input,
            "output_payload": {"value": 42},
            "outcome": "success",
            "duration_ms": 12,
        }
    )
    acks["thinking"] = session.submit(
        {
            "behavior": "Thinking",
            "record_id": ids["thinking"],
            "upstream_record_id": [ids["toolcalling"]],
            "executor": "ai",
            "record_phase": "post_execution",
            # Raw strings: uploaded as text content.
            "prompt": prompt,
            "inputs": [{"input_record_id": ids["toolcalling"], "input_payload": "value=42"}],
            "output_payload": "Act: the value is above the threshold.",
        }
    )
    acks["acting"] = session.submit(
        {
            "behavior": "Acting",
            "record_id": ids["acting"],
            "upstream_record_id": [ids["thinking"]],
            "executor": "det",
            "record_phase": "pre_execution",
            "action_type": "noop",
            "target_system": "integration-tests",
            "action_summary": "no-op awaiting approval",
            "parameters": {"target": "none"},
            "dry_run": True,
            "execution_status": "pending",
        }
    )
    acks["attesting"] = session.submit_attesting(
        {
            "record_id": ids["attesting"],
            "upstream_record_id": [ids["acting"]],
            "operator_id": "it-operator",
            "disposition": "approve",
            "decision": {"approved": True, "action": "noop"},
            "gate_kind": "integration-test",
            "written_by": WRITTEN_BY,
        }
    )
    return Cycle(session_id=session.id, ids=ids, acks=acks, tool_input=tool_input, prompt=prompt)


class TestAgent:
    def test_register_agent_returns_uuid(self, agent_id: str) -> None:
        assert str(uuid.UUID(agent_id)) == agent_id

    def test_resolve_agent_id_round_trips(self, staging_env: StagingEnv, agent_id: str) -> None:
        resolved = LedgerClient.resolve_agent_id(
            ResolveAgentOpts(
                api_key=staging_env.api_key,
                endpoint=staging_env.base_url,
                name=staging_env.agent_name,
            )
        )
        assert resolved == agent_id


class TestDecisionCycle:
    def test_every_step_is_acknowledged(self, cycle: Cycle) -> None:
        for step, ack in cycle.acks.items():
            assert ack["record_id"] == cycle.ids[step]
            assert ack["session_id"] == cycle.session_id
            assert ack["is_duplicate"] is False

    def test_object_payloads_are_stored_as_json_content(
        self, client: LedgerClient, cycle: Cycle
    ) -> None:
        tc = client.get_record(cycle.ids["toolcalling"])
        assert tc["outcome"] == "success"
        assert tc["input_payload"]["media_type"] == "application/json"
        assert json.loads(client.get_content(tc["input_payload"])) == cycle.tool_input
        assert json.loads(client.get_content(tc["output_payload"])) == {"value": 42}

    def test_raw_strings_are_stored_as_text_content(
        self, client: LedgerClient, cycle: Cycle
    ) -> None:
        th = client.get_record(cycle.ids["thinking"])
        assert th["prompt"]["media_type"] == TEXT
        assert client.get_content(th["prompt"]).decode("utf-8") == cycle.prompt
        assert client.get_content(th["output_payload"]) == b"Act: the value is above the threshold."
        (thinking_input,) = th["inputs"]
        assert thinking_input["input_record_id"] == cycle.ids["toolcalling"]
        assert client.get_content(thinking_input["input_payload"]) == b"value=42"

    def test_attesting_entry_point(self, client: LedgerClient, cycle: Cycle) -> None:
        at = client.get_record(cycle.ids["attesting"])
        assert at["behavior"] == "Attesting"
        assert at["executor"] == "human"
        assert at["record_phase"] == "concurrent"
        assert at["operator_id"] == "it-operator"
        assert at["disposition"] == "approve"
        assert at["decision"] == {"approved": True, "action": "noop"}
        assert at["gate_kind"] == "integration-test"
        assert at["written_by"] == WRITTEN_BY
        assert at["upstream_record_id"] == [cycle.ids["acting"]]

    def test_reject_without_reason_fails_locally(
        self, staging_env: StagingEnv, agent_id: str
    ) -> None:
        offline = LedgerClient(
            LedgerClientConfig(
                agent_id=agent_id,
                api_key=staging_env.api_key,
                endpoint=staging_env.base_url,
                http_transport=NoNetwork(),
            )
        )
        session = offline.new_session(fresh_session_id("reject"))
        with pytest.raises(ValidationError, match="reason is required"):
            session.submit_attesting(
                {
                    "operator_id": "it-operator",
                    "disposition": "reject",
                    "gate_kind": "integration-test",
                    "written_by": WRITTEN_BY,
                }
            )


class TestIdempotencyAndBatch:
    def test_submit_is_idempotent_on_record_id(self, client: LedgerClient) -> None:
        session = client.new_session(fresh_session_id("idempotency"))
        record = {
            "behavior": "Other",
            "record_id": new_record_id(),
            "client_ts_utc": now_epoch_ms(),
            "executor": "det",
            "record_phase": "post_execution",
            "label": "idempotency-probe",
            "data": {"iteration": 1},
        }

        first = session.submit(record)
        second = session.submit(record)

        assert first["is_duplicate"] is False
        assert second["is_duplicate"] is True
        assert second["record_id"] == record["record_id"]
        assert second["server_ts_utc"] == first["server_ts_utc"]

    def test_submit_batch_of_three(self, client: LedgerClient) -> None:
        session = client.new_session(fresh_session_id("batch"))

        ack = session.submit_batch(
            [
                {
                    "behavior": "Other",
                    "executor": "det",
                    "record_phase": "post_execution",
                    "label": f"py-batch-{i}",
                    "data": {"i": i},
                }
                for i in range(3)
            ]
        )

        assert ack["batch_id"]
        assert len(ack["results"]) == 3
        for result in ack["results"]:
            assert "code" not in result, result
        fetched = client.get_session(session.id)
        assert [r["record_id"] for r in fetched["records"]] == [
            r["record_id"] for r in ack["results"]
        ]


class TestReads:
    def test_get_record_carries_0_4_fields_and_sequence(
        self, client: LedgerClient, agent_id: str, cycle: Cycle
    ) -> None:
        tc = client.get_record(cycle.ids["toolcalling"])
        assert tc["record_id"] == cycle.ids["toolcalling"]
        assert tc["agent_id"] == agent_id
        assert tc["session_id"] == cycle.session_id
        assert tc["behavior"] == "ToolCalling"
        assert tc["schema_version"] == "0.4"
        assert tc["executor"] == "det"
        assert tc["record_phase"] == "post_execution"
        assert tc["outcome"] == "success"
        assert tc["duration_ms"] == 12
        assert isinstance(tc["sequence"], int)
        assert tc["upstream_record_id"] == [cycle.ids["observing"]]

    def test_get_session_returns_records_in_sequence_order(
        self, client: LedgerClient, cycle: Cycle
    ) -> None:
        fetched = client.get_session(cycle.session_id)
        assert fetched["session_id"] == cycle.session_id
        assert [r["record_id"] for r in fetched["records"]] == list(cycle.ids.values())
        sequences = [r["sequence"] for r in fetched["records"]]
        assert sequences == sorted(set(sequences))

    def test_get_trace_is_newest_first_and_paginates(
        self, client: LedgerClient, cycle: Cycle
    ) -> None:
        assert cycle.ids  # the cycle alone gives this agent five records

        first = client.get_trace(GetTraceOpts(limit=2))
        first_seq = [r["sequence"] for r in first["records"]]
        assert len(first_seq) == 2
        assert first_seq == sorted(first_seq, reverse=True)
        assert first["next_cursor"] is not None

        second = client.get_trace(GetTraceOpts(before=first["next_cursor"], limit=2))
        second_seq = [r["sequence"] for r in second["records"]]
        assert second_seq
        assert second_seq == sorted(second_seq, reverse=True)
        assert max(second_seq) < min(first_seq)


class TestContent:
    def test_put_and_get_content_round_trip(self, client: LedgerClient) -> None:
        data = os.urandom(64) + b"\x00\xff\xfe"

        ref = client.put_content(data)

        assert ref == {
            "sha256": hashlib.sha256(data).hexdigest(),
            "bytes": len(data),
            "media_type": "application/octet-stream",
        }
        assert client.get_content(ref) == data
        assert client.get_content(ref["sha256"]) == data

    def test_text_round_trip_with_media_type(self, client: LedgerClient) -> None:
        text = f"héllo — {uuid.uuid4()}"

        ref = client.put_content(text, media_type="text/markdown")

        assert ref["media_type"] == "text/markdown"
        assert ref["bytes"] == len(text.encode("utf-8"))
        assert client.get_content(ref).decode("utf-8") == text


class TestErrors:
    def test_missing_record_raises_not_found(self, client: LedgerClient) -> None:
        with pytest.raises(NotFoundError):
            client.get_record(new_record_id())

    def test_missing_content_raises_not_found(self, client: LedgerClient) -> None:
        with pytest.raises(NotFoundError):
            client.get_content("0" * 64)

    def test_bad_api_key_raises_auth_error(
        self, staging_env: StagingEnv, agent_id: str, cycle: Cycle
    ) -> None:
        bad = LedgerClient(
            LedgerClientConfig(
                agent_id=agent_id,
                api_key=f"sl_{'0' * 64}",
                endpoint=staging_env.base_url,
                retry={"attempts": 1, "backoff_ms": []},
            )
        )
        with pytest.raises(AuthError):
            bad.get_record(cycle.ids["observing"])
