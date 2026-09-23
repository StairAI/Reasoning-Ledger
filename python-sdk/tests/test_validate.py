import pytest

from reasoning_ledger.constants import SIZE_LIMITS
from reasoning_ledger.errors import ValidationError
from reasoning_ledger.validate import validate_batch, validate_record

# ---------------------------------------------------------------------------
# Shared minimal valid record builders (schema 0.4)
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


def base(behavior: str, fields: dict[str, object]) -> dict[str, object]:
    return {
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "behavior": behavior,
        "client_ts_utc": 1_700_000_000_000,
        "executor": "det",
        "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        "record_phase": "post_execution",
        "schema_version": "0.4",
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
            "tool_meta": {"category": "external_api", "tool_id": "weather_api"},
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


def make_acting(**overrides: object) -> dict[str, object]:
    return base(
        "Acting",
        {
            "action_summary": "Sent email",
            "action_type": "email",
            "dry_run": False,
            "execution_status": "confirmed",
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
            "record_phase": "concurrent",
            "written_by": {"component": "review-ui", "credential": "svc-key"},
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

    def test_tool_calling_passes(self) -> None:
        validate_record(make_tool_calling())

    def test_thinking_passes(self) -> None:
        validate_record(make_thinking())

    def test_acting_passes(self) -> None:
        validate_record(make_acting())

    def test_attesting_passes(self) -> None:
        validate_record(
            make_attesting(
                decision={"amount": 120},
                effects=JSON_REF,
                evidence_refs=["6ba7b810-9dad-41d1-80b4-00c04fd430c8", TEXT_REF],
            )
        )

    def test_other_passes(self) -> None:
        validate_record(make_other())

    def test_planning_passes(self) -> None:
        validate_record(
            base("Planning", {"goal": "Win", "steps": [{"description": "Analyse", "index": 0}]})
        )

    def test_reflecting_passes(self) -> None:
        validate_record(base("Reflecting", {"inputs": [], "output_payload": TEXT_REF}))

    def test_optional_0_4_base_fields_pass(self) -> None:
        validate_record(
            make_acting(
                duration_ms=35,
                outcome="failure",
                sources=[{"kind": "api", "ref": "smtp://relay"}],
                verdict={"conclusion": "retry later", "decided_by": "policy-v2"},
            )
        )

    def test_internal_reasoning_is_a_content_ref(self) -> None:
        invocation = {"model_name": "m", "provider": "p", "internal_reasoning": TEXT_REF}
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

    def test_tool_calling_requires_outcome(self) -> None:
        record = make_tool_calling()
        del record["outcome"]
        with pytest.raises(ValidationError):
            validate_record(record)

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
        big = {f"key{i}": "x" * 45 for i in range(400)}
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
