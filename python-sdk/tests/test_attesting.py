"""Tests for the Attesting entry point (client.submit_attesting / session.submit_attesting)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from reasoning_ledger import ValidationError, is_valid_record_id

from .fakes import AGENT_ID, ENDPOINT, FakeLedgerServer, make_client, sha256_of

TEXT = "text/plain; charset=utf-8"
WRITTEN_BY = {"component": "review-ui", "credential": "svc-reviewer"}


def attesting_input(**overrides: Any) -> dict[str, Any]:
    return {
        "decision": {"amount": 120, "currency": "EUR"},
        "disposition": "approve",
        "gate_kind": "payment-approval",
        "operator_id": "reviewer-7",
        "outcome": "success",
        "session_id": "s-1",
        "written_by": WRITTEN_BY,
        **overrides,
    }


def posted(server: FakeLedgerServer) -> dict[str, Any]:
    (post,) = server.requests("POST", "/v1/records")
    assert post["url"] == f"{ENDPOINT}/v1/records"
    return json.loads(post["body"] or "{}")


class TestSubmitAttesting:
    def test_sets_behavior_executor_and_default_record_phase(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        ack = client.submit_attesting(attesting_input())

        record = posted(server)
        assert record["behavior"] == "Attesting"
        assert record["executor"] == "human"
        assert record["record_phase"] == "concurrent"
        assert ack["record_id"] == record["record_id"]

    def test_applies_the_usual_auto_fill(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit_attesting(attesting_input())

        record = posted(server)
        assert record["agent_id"] == AGENT_ID
        assert record["schema_version"] == "0.5"
        assert is_valid_record_id(record["record_id"])
        assert isinstance(record["client_ts_utc"], int)

    def test_passes_the_disposition_fields_through(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit_attesting(
            attesting_input(
                channel="interactive",
                disposition="edit",
                patch={"amount": 100},
                seen_completeness="complete",
            )
        )

        record = posted(server)
        assert record["written_by"] == WRITTEN_BY
        assert record["decision"] == {"amount": 120, "currency": "EUR"}
        assert record["disposition"] == "edit"
        assert record["patch"] == {"amount": 100}
        assert record["outcome"] == "success"
        assert (record["channel"], record["seen_completeness"]) == ("interactive", "complete")

    def test_evidence_refs_are_gone(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        with pytest.raises(ValidationError):
            client.submit_attesting(attesting_input(evidence_refs=[]))

        assert server.calls == []

    def test_caller_supplied_record_phase_is_kept(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit_attesting(attesting_input(record_phase="pre_execution"))

        assert posted(server)["record_phase"] == "pre_execution"

    def test_behavior_and_executor_are_always_set_by_the_sdk(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit_attesting(attesting_input(behavior="Acting", executor="ai"))

        record = posted(server)
        assert (record["behavior"], record["executor"]) == ("Attesting", "human")

    def test_raw_effects_are_uploaded_first(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        effects = b'{"rule":"limit","value":500}'

        client.submit_attesting(attesting_input(effects={"rule": "limit", "value": 500}))

        assert [c["method"] for c in server.calls] == ["PUT", "POST"]
        assert posted(server)["effects"] == {
            "bytes": len(effects),
            "media_type": "application/json",
            "sha256": sha256_of(effects),
        }

    def test_reject_without_reason_fails_before_any_request(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        with pytest.raises(ValidationError, match="reason is required"):
            client.submit_attesting(attesting_input(disposition="reject", effects="undo"))

        assert server.calls == []

    def test_reject_with_reason_is_submitted(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        client.submit_attesting(attesting_input(disposition="reject", reason="wrong payee"))

        assert posted(server)["reason"] == "wrong payee"

    @pytest.mark.parametrize(
        ("disposition", "expected"), [("no_response", "timeout"), ("cancel", "cancelled")]
    )
    def test_outcome_rules_fail_before_any_request(self, disposition: str, expected: str) -> None:
        server = FakeLedgerServer()
        client = make_client(server)

        with pytest.raises(ValidationError, match=f"outcome must be '{expected}'"):
            client.submit_attesting(attesting_input(disposition=disposition, effects="undo"))

        assert server.calls == []

    def test_no_response_with_timeout_is_submitted(self) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        record = attesting_input(channel="headless", disposition="no_response", outcome="timeout")
        del record["decision"]

        client.submit_attesting(record)

        sent = posted(server)
        assert (sent["disposition"], sent["outcome"]) == ("no_response", "timeout")

    @pytest.mark.parametrize(
        "field", ["operator_id", "disposition", "gate_kind", "written_by", "outcome"]
    )
    def test_required_fields_are_checked_locally(self, field: str) -> None:
        server = FakeLedgerServer()
        client = make_client(server)
        record = attesting_input()
        del record[field]

        with pytest.raises(ValidationError):
            client.submit_attesting(record)

        assert server.calls == []

    def test_answers_an_escalation_whose_question_is_uploaded(self) -> None:
        server = FakeLedgerServer()
        session = make_client(server).new_session("review-session")
        question = "Pay 120 EUR to a new payee?"

        escalation = session.submit(
            {
                "asked": question,
                "behavior": "Escalating",
                "executor": "ai",
                "kind": "permission",
                "options": ["approve", "reject"],
                "outcome": "success",
                "record_phase": "post_execution",
            }
        )
        session.submit_attesting(attesting_input(upstream_record_id=[escalation["record_id"]]))

        escalating, attesting = server.records
        assert escalating["asked"] == server.ref_for(question.encode(), TEXT)
        assert server.upload_of(question.encode())["headers"]["content-type"] == TEXT
        assert attesting["behavior"] == "Attesting"
        assert attesting["upstream_record_id"] == [escalating["record_id"]]

    def test_approves_a_memory_write_whose_target_is_uploaded(self) -> None:
        server = FakeLedgerServer()
        session = make_client(server).new_session("review-session")
        rule = "Payments to a new payee above 100 EUR need a second reviewer"

        approval = session.submit_attesting(attesting_input())
        session.submit(
            {
                "approved_by": approval["record_id"],
                "behavior": "Memorizing",
                "executor": "ai",
                "op": "add",
                "outcome": "success",
                "record_phase": "post_execution",
                "scope": "org",
                "target": rule,
                "upstream_record_id": [approval["record_id"]],
            }
        )

        _, memorizing = server.records
        assert memorizing["target"] == server.ref_for(rule.encode(), TEXT)
        assert memorizing["approved_by"] == approval["record_id"]

    def test_session_injects_its_session_id(self) -> None:
        server = FakeLedgerServer()
        session = make_client(server).new_session("review-session")

        session.submit_attesting(attesting_input(session_id="ignored"))

        record = posted(server)
        assert record["session_id"] == "review-session"
        assert record["behavior"] == "Attesting"
        assert record["record_phase"] == "concurrent"
