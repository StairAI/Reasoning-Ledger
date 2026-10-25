from collections.abc import Callable

import pytest

from reasoning_ledger.constants import SIZE_LIMITS
from reasoning_ledger.errors import ValidationError
from reasoning_ledger.validate import validate_batch, validate_record

# ---------------------------------------------------------------------------
# Shared minimal valid record builders (schema 0.5)
# ---------------------------------------------------------------------------

TEXT_REF = {
    "bytes": 17,
    "media_type": "text/plain; charset=utf-8",
    "sha256": "a" * 64,
}
JSON_REF = {
    "bytes": 15,
    "media_type": "application/json",
    "sha256": "b" * 64,
}
RECORD_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8"
OTHER_RECORD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"


def base(behavior: str, fields: dict[str, object]) -> dict[str, object]:
    return {
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "behavior": behavior,
        "client_ts_utc": 1_700_000_000_000,
        "executor": "det",
        "record_id": RECORD_ID,
        "record_phase": "post_execution",
        "schema_version": "0.5",
        "session_id": "session-001",
        **fields,
    }


def make_observing(**overrides: object) -> dict[str, object]:
    return base(
        "Observing",
        {
            "trigger_description": "User sent a message",
            "trigger_payload_summary": "Hello world",
            "trigger_source": "webhook",
            "trigger_type": "signal_trigger",
            **overrides,
        },
    )


def make_tool_calling(**overrides: object) -> dict[str, object]:
    return base(
        "ToolCalling",
        {
            "description": "Fetched weather data",
            "input_payload": JSON_REF,
            "outcome": "success",
            "output_payload": JSON_REF,
            "tool_meta": {"category": "external_api", "name": "weather_api"},
            **overrides,
        },
    )


def make_thinking(**overrides: object) -> dict[str, object]:
    return base(
        "Thinking",
        {
            "executor": "ai",
            "inputs": [{"input_payload": TEXT_REF}],
            "output_payload": TEXT_REF,
            "prompt": TEXT_REF,
            **overrides,
        },
    )


def make_planning(**overrides: object) -> dict[str, object]:
    return base(
        "Planning",
        {
            "executor": "ai",
            "goal": "Win the match",
            "steps": [
                {"description": "Gather odds", "index": 0},
                {"depends_on": [0], "description": "Compare with xG", "index": 1},
            ],
            **overrides,
        },
    )


def make_acting(**overrides: object) -> dict[str, object]:
    return base(
        "Acting",
        {
            "action_summary": "Sent email",
            "action_type": "email.send",
            "execution_status": "confirmed",
            "outcome": "success",
            "parameters": {},
            "target_system": "smtp",
            **overrides,
        },
    )


def make_attesting(**overrides: object) -> dict[str, object]:
    return base(
        "Attesting",
        {
            "disposition": "approve",
            "executor": "human",
            "gate_kind": "pre-send",
            "operator_id": "reviewer-7",
            "outcome": "success",
            "record_phase": "concurrent",
            "written_by": {"component": "review-ui", "credential": "svc-key"},
            **overrides,
        },
    )


def make_escalating(**overrides: object) -> dict[str, object]:
    return base(
        "Escalating",
        {
            "asked": TEXT_REF,
            "executor": "ai",
            "kind": "permission",
            "outcome": "success",
            "record_phase": "concurrent",
            **overrides,
        },
    )


def make_delegating(**overrides: object) -> dict[str, object]:
    return base(
        "Delegating",
        {
            "executor": "ai",
            "goal": TEXT_REF,
            "kind": "spawn",
            "outcome": "success",
            **overrides,
        },
    )


def make_memorizing(**overrides: object) -> dict[str, object]:
    return base(
        "Memorizing",
        {
            "executor": "ai",
            "op": "add",
            "outcome": "success",
            "scope": "project",
            "target": TEXT_REF,
            **overrides,
        },
    )


def make_other(**overrides: object) -> dict[str, object]:
    return base("Other", {"data": {"key": "value"}, "label": "file_edit", **overrides})


# ---------------------------------------------------------------------------
# validate_record — valid records
# ---------------------------------------------------------------------------


class TestValidateRecordValid:
    def test_observing_passes(self) -> None:
        validate_record(make_observing())  # must not raise

    @pytest.mark.parametrize("trigger_type", ["human_trigger", "outcome_trigger", "agent_trigger"])
    def test_observing_new_trigger_types_pass(self, trigger_type: str) -> None:
        validate_record(make_observing(trigger_type=trigger_type))

    def test_tool_calling_passes(self) -> None:
        validate_record(make_tool_calling())

    def test_tool_calling_typed_tool_meta_and_effect_pass(self) -> None:
        record = make_tool_calling(
            effect="read",
            tool_meta={
                "call_id": "toolu_01",
                "name": "forecast",
                "namespace": "weather",
                "server": "weather-mcp",
                "tool_type": "mcp",
                "version": "2.1",
            },
        )
        del record["description"]  # optional since 0.5
        validate_record(record)

    def test_thinking_passes(self) -> None:
        validate_record(make_thinking())

    def test_thinking_needs_only_output_payload(self) -> None:
        record = make_thinking()
        del record["prompt"], record["inputs"]
        validate_record(record)

    def test_planning_passes(self) -> None:
        validate_record(make_planning())
        validate_record(make_planning(contingencies=["hedge"], revision_of=OTHER_RECORD_ID))

    def test_thinking_rejects_a_plan(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_thinking(steps=[{"description": "Gather odds", "index": 0}]))

    def test_acting_passes(self) -> None:
        validate_record(make_acting())

    def test_cancelled_outcome_and_execution_status_pass(self) -> None:
        validate_record(make_delegating(error_type="user.abort", outcome="cancelled"))
        validate_record(make_acting(execution_status="cancelled", outcome="cancelled"))

    def test_acting_parameters_are_optional(self) -> None:
        record = make_acting(action_type="answer.final", target_system="chat")
        del record["parameters"]  # optional since 0.5
        validate_record(record)

    def test_attesting_passes(self) -> None:
        validate_record(
            make_attesting(
                channel="async",
                decision={"amount": 120},
                effects=JSON_REF,
                seen_completeness="partial",
                upstream_record_id=[OTHER_RECORD_ID],
            )
        )

    def test_escalating_passes(self) -> None:
        validate_record(
            make_escalating(default="approve", duration_ms=1200, options=["approve", "reject"])
        )

    def test_delegating_passes(self) -> None:
        validate_record(
            make_delegating(
                child_session_id="child-session-001",
                delegate_agent_id="code-reviewer",
                result=JSON_REF,
                awaited=True,
            )
        )

    def test_memorizing_passes(self) -> None:
        validate_record(make_memorizing(approved_by=OTHER_RECORD_ID, op="update", scope="global"))

    def test_other_passes(self) -> None:
        validate_record(make_other(proposed_behavior="Reporting"))

    def test_reflecting_passes(self) -> None:
        validate_record(
            base("Reflecting", {"inputs": [], "kind": "settlement", "output_payload": TEXT_REF})
        )

    def test_optional_base_fields_pass(self) -> None:
        validate_record(
            make_acting(
                classification={
                    "alternatives": [{"behavior": "ToolCalling", "confidence": 0.2}],
                    "confidence": 0.8,
                    "mapper": "collector@0.3",
                    "source": "rule",
                },
                duration_ms=35,
                error_type="http.5xx",
                on_behalf_of_agent_id=OTHER_RECORD_ID,
                outcome="failure",
                sources=[{"kind": "record", "ref": OTHER_RECORD_ID}],
                verdict={"conclusion": "retry later", "decided_by": "policy"},
                written_by={"component": "mailer", "credential": "svc-mail"},
            )
        )

    def test_internal_reasoning_is_a_content_ref(self) -> None:
        invocation = {"model_name": "m", "provider": "p", "internal_reasoning": TEXT_REF}
        validate_record(make_thinking(model_invocation=invocation))

    def test_new_model_invocation_fields_pass(self) -> None:
        invocation = {
            "cache_creation_tokens": 0,
            "cache_read_tokens": 1200,
            "invocation_kind": "cached",
            "model_name": "m",
            "provider": "p",
            "request_id": "req_01",
        }
        validate_record(make_thinking(model_invocation=invocation))

    @pytest.mark.parametrize("replay_of", [OTHER_RECORD_ID, TEXT_REF])
    def test_replay_may_leave_provider_and_model_name_null(self, replay_of: object) -> None:
        invocation = {
            "invocation_kind": "replay",
            "model_name": None,
            "provider": None,
            "replay_of": replay_of,
        }
        validate_record(make_thinking(model_invocation=invocation))


# ---------------------------------------------------------------------------
# validate_record — schema violations
# ---------------------------------------------------------------------------


class TestValidateRecordSchemaViolations:
    def test_missing_behavior_raises(self) -> None:
        record = make_observing()
        del record["behavior"]
        with pytest.raises(ValidationError):
            validate_record(record)

    def test_invalid_behavior_raises(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_observing(behavior="Flying"))

    def test_missing_session_id_raises(self) -> None:
        record = make_observing()
        del record["session_id"]
        with pytest.raises(ValidationError):
            validate_record(record)

    def test_invalid_record_id_raises(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_observing(record_id="not-a-uuid"))

    def test_missing_observing_field_raises(self) -> None:
        record = make_observing()
        del record["trigger_source"]
        with pytest.raises(ValidationError):
            validate_record(record)

    @pytest.mark.parametrize("field", ["executor", "record_phase"])
    def test_executor_and_record_phase_are_required(self, field: str) -> None:
        record = make_observing()
        del record[field]
        with pytest.raises(ValidationError):
            validate_record(record)

    def test_raw_text_at_a_content_position_raises(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            validate_record(make_thinking(prompt="What should I do?"))
        assert exc_info.value.details is not None
        assert exc_info.value.details["field"] == "Thinking.prompt"

    def test_raw_text_at_a_new_content_position_raises(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            validate_record(make_escalating(asked="May I send it?"))
        assert exc_info.value.details is not None
        assert exc_info.value.details["field"] == "Escalating.asked"

    def test_planning_needs_a_goal(self) -> None:
        planning = make_planning()
        del planning["goal"]
        with pytest.raises(ValidationError) as exc_info:
            validate_record(planning)
        assert exc_info.value.details is not None
        assert exc_info.value.details["field"] == "Planning.goal"

    @pytest.mark.parametrize(
        "make",
        [
            make_tool_calling,
            make_acting,
            make_attesting,
            make_escalating,
            make_delegating,
            make_memorizing,
        ],
    )
    def test_outcome_is_required(self, make: Callable[[], dict[str, object]]) -> None:
        record = make()
        del record["outcome"]
        with pytest.raises(ValidationError) as exc_info:
            validate_record(record)
        assert exc_info.value.details is not None
        assert exc_info.value.details["field"] == f"{record['behavior']}.outcome"

    @pytest.mark.parametrize(
        ("make", "field"),
        [
            (make_escalating, "kind"),
            (make_escalating, "asked"),
            (make_delegating, "kind"),
            (make_delegating, "goal"),
            (make_memorizing, "scope"),
            (make_memorizing, "target"),
            (make_memorizing, "op"),
        ],
    )
    def test_new_behaviors_require_their_fields(
        self, make: Callable[[], dict[str, object]], field: str
    ) -> None:
        record = make()
        del record[field]
        with pytest.raises(ValidationError):
            validate_record(record)

    @pytest.mark.parametrize(
        ("record", "field"),
        [
            (make_acting(dry_run=False), "Acting.dry_run"),
            (make_attesting(evidence_refs=[OTHER_RECORD_ID]), "Attesting.evidence_refs"),
            (make_observing(external_trigger_id="evt-1"), "Observing.external_trigger_id"),
            (make_other(parent_record_id=OTHER_RECORD_ID), "Other.parent_record_id"),
            (
                make_thinking(
                    model_invocation={"model_name": "m", "model_version": "1", "provider": "p"}
                ),
                "Thinking.model_invocation.model_version",
            ),
        ],
    )
    def test_removed_fields_are_rejected(self, record: dict[str, object], field: str) -> None:
        with pytest.raises(ValidationError) as exc_info:
            validate_record(record)
        assert exc_info.value.details is not None
        assert exc_info.value.details["field"] == field

    @pytest.mark.parametrize(
        "action_type", ["email", "Email.send", "email.", ".send", "email send"]
    )
    def test_action_type_must_be_namespaced(self, action_type: str) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_acting(action_type=action_type))

    def test_verdict_decided_by_is_a_fixed_vocabulary(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_acting(verdict={"conclusion": "ok", "decided_by": "policy-v2"}))

    def test_tool_meta_requires_a_name(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_tool_calling(tool_meta={"category": "external_api"}))

    def test_tool_calling_success_flag_is_gone(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_tool_calling(success=True))

    def test_attesting_executor_must_be_human(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_attesting(executor="ai"))

    def test_content_ref_with_extra_keys_raises(self) -> None:
        with pytest.raises(ValidationError):
            validate_record(make_tool_calling(input_payload={**JSON_REF, "extra": 1}))

    def test_error_code_is_validation_failed(self) -> None:
        record = make_observing()
        del record["behavior"]
        caught: ValidationError | None = None
        try:
            validate_record(record)
        except ValidationError as exc:
            caught = exc
        assert caught is not None
        assert caught.code == "validation_failed"


# ---------------------------------------------------------------------------
# validate_record — cross-field rules the generated models miss
# ---------------------------------------------------------------------------


class TestCrossFieldRules:
    def test_confirmed_public_chain_acting_requires_execution_id(self) -> None:
        record = make_acting(target_system="public-chain", execution_status="confirmed")
        with pytest.raises(ValidationError, match="execution_id is required") as exc_info:
            validate_record(record)
        assert exc_info.value.details == {"field": "execution_id", "reason": "required"}

    def test_empty_execution_id_counts_as_missing(self) -> None:
        record = make_acting(target_system="public-chain", execution_id="")
        with pytest.raises(ValidationError, match="execution_id is required"):
            validate_record(record)

    def test_confirmed_public_chain_acting_with_execution_id_passes(self) -> None:
        validate_record(make_acting(target_system="public-chain", execution_id="0xabc"))

    @pytest.mark.parametrize(
        ("target_system", "execution_status"),
        [("public-chain", "pending"), ("public-chain", "simulated"), ("smtp", "confirmed")],
    )
    def test_other_acting_combinations_need_no_execution_id(
        self, target_system: str, execution_status: str
    ) -> None:
        validate_record(make_acting(target_system=target_system, execution_status=execution_status))

    def test_reject_requires_reason(self) -> None:
        with pytest.raises(ValidationError, match="reason is required") as exc_info:
            validate_record(make_attesting(disposition="reject"))
        assert exc_info.value.details == {"field": "reason", "reason": "required"}

    def test_reject_with_reason_passes(self) -> None:
        validate_record(make_attesting(disposition="reject", reason="amount is wrong"))

    @pytest.mark.parametrize("disposition", ["approve", "edit"])
    def test_other_dispositions_need_no_reason(self, disposition: str) -> None:
        validate_record(make_attesting(disposition=disposition))

    @pytest.mark.parametrize(
        ("disposition", "expected", "given"),
        [
            ("no_response", "timeout", "success"),
            ("no_response", "timeout", "cancelled"),
            ("cancel", "cancelled", "success"),
            ("cancel", "cancelled", "timeout"),
        ],
    )
    def test_no_response_and_cancel_fix_the_outcome(
        self, disposition: str, expected: str, given: str
    ) -> None:
        record = make_attesting(disposition=disposition, outcome=given)
        message = f"outcome must be '{expected}' when disposition is '{disposition}'"
        with pytest.raises(ValidationError, match=message) as exc_info:
            validate_record(record)
        assert exc_info.value.details == {"field": "outcome", "reason": f"must be '{expected}'"}

    @pytest.mark.parametrize(
        ("disposition", "outcome"), [("no_response", "timeout"), ("cancel", "cancelled")]
    )
    def test_no_response_and_cancel_with_their_outcome_pass(
        self, disposition: str, outcome: str
    ) -> None:
        validate_record(
            make_attesting(channel="headless", disposition=disposition, outcome=outcome)
        )

    def test_batch_reports_rule_violations_per_record(self) -> None:
        results = validate_batch([make_attesting(disposition="reject"), make_attesting()])
        assert isinstance(results[0], ValidationError)
        assert results[1] is None


# ---------------------------------------------------------------------------
# validate_record — size limit violations
# ---------------------------------------------------------------------------


class TestValidateRecordSizeLimits:
    def test_content_positions_have_no_client_side_limits(self) -> None:
        for key in ("THINKING_PROMPT", "THINKING_OUTPUT", "TOOL_INPUT", "TOOL_OUTPUT"):
            assert key not in SIZE_LIMITS
        for key in (
            "ACTING_PARAMETERS",
            "BATCH_JSON",
            "NOTES",
            "OTHER_DATA",
            "RECORD_JSON",
            "TAGS_COUNT",
            "TAG_LENGTH",
            "TOOL_META",
            "TRIGGER_PAYLOAD_SUMMARY",
        ):
            assert key in SIZE_LIMITS

    def test_trigger_payload_summary_too_long(self) -> None:
        oversized = "x" * (SIZE_LIMITS["TRIGGER_PAYLOAD_SUMMARY"] + 1)
        with pytest.raises(ValidationError):
            validate_record(make_observing(trigger_payload_summary=oversized))

    def test_tool_meta_too_large(self) -> None:
        big = {"name": "weather_api", **{f"key{i}": "x" * 45 for i in range(400)}}
        with pytest.raises(ValidationError, match="tool_meta"):
            validate_record(make_tool_calling(tool_meta=big))

    def test_acting_parameters_too_large(self) -> None:
        big = {f"key{i}": "x" * 45 for i in range(400)}
        with pytest.raises(ValidationError):
            validate_record(make_acting(parameters=big))

    def test_other_data_too_large(self) -> None:
        big = {f"key{i}": "x" * 45 for i in range(400)}
        with pytest.raises(ValidationError):
            validate_record(make_other(data=big))

    def test_record_total_too_large(self) -> None:
        with pytest.raises(ValidationError, match="64 KB"):
            validate_record(make_attesting(decision="x" * SIZE_LIMITS["RECORD_JSON"]))


# ---------------------------------------------------------------------------
# validate_batch
# ---------------------------------------------------------------------------


class TestValidateBatch:
    def test_empty_returns_empty(self) -> None:
        assert validate_batch([]) == []

    def test_all_valid_returns_all_none(self) -> None:
        results = validate_batch([make_observing(), make_acting()])
        assert results == [None, None]

    def test_mixed_returns_none_for_valid_error_for_invalid(self) -> None:
        invalid = make_observing()
        del invalid["behavior"]
        results = validate_batch([make_observing(), invalid, make_acting()])
        assert results[0] is None
        assert isinstance(results[1], ValidationError)
        assert results[2] is None

    def test_exceeding_50_records_raises_immediately(self) -> None:
        records = [make_observing() for _ in range(51)]
        with pytest.raises(ValidationError):
            validate_batch(records)

    def test_batch_overflow_error_code(self) -> None:
        records = [make_observing() for _ in range(51)]
        caught: ValidationError | None = None
        try:
            validate_batch(records)
        except ValidationError as exc:
            caught = exc
        assert caught is not None
        assert caught.code == "validation_failed"
