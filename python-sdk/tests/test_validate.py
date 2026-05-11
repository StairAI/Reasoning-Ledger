import pytest

from reasoning_ledger.constants import SIZE_LIMITS
from reasoning_ledger.errors import ValidationError
from reasoning_ledger.validate import validate_batch, validate_record

# ---------------------------------------------------------------------------
# Shared minimal valid record builders
# ---------------------------------------------------------------------------


def make_observing(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "behavior": "Observing",
        "client_ts_utc": 1_700_000_000_000,
        "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        "schema_version": "1.0",
        "session_id": "session-001",
        "trigger_description": "User sent a message",
        "trigger_payload_summary": "Hello world",
        "trigger_source": "webhook",
        "trigger_type": "signal_trigger",
    }
    base.update(overrides)
    return base


def make_tool_calling(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "behavior": "ToolCalling",
        "client_ts_utc": 1_700_000_000_000,
        "description": "Fetched weather data",
        "input_payload": {"city": "Paris"},
        "output_payload": {"temp": 20},
        "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        "schema_version": "1.0",
        "session_id": "session-001",
        "success": True,
        "tool_meta": {"category": "external_api", "tool_id": "weather_api"},
    }
    base.update(overrides)
    return base


def make_thinking(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "behavior": "Thinking",
        "client_ts_utc": 1_700_000_000_000,
        "inputs": [],
        "output_payload": "result",
        "prompt": "What should I do?",
        "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        "schema_version": "1.0",
        "session_id": "session-001",
    }
    base.update(overrides)
    return base


def make_acting(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "action_summary": "Sent email",
        "action_type": "email",
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "behavior": "Acting",
        "client_ts_utc": 1_700_000_000_000,
        "dry_run": False,
        "execution_status": "confirmed",
        "parameters": {},
        "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        "schema_version": "1.0",
        "session_id": "session-001",
        "target_system": "smtp",
    }
    base.update(overrides)
    return base


def make_other(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "agent_id": "550e8400-e29b-41d4-a716-446655440000",
        "behavior": "Other",
        "client_ts_utc": 1_700_000_000_000,
        "data": {"key": "value"},
        "label": "file_edit",
        "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        "schema_version": "1.0",
        "session_id": "session-001",
    }
    base.update(overrides)
    return base


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

    def test_other_passes(self) -> None:
        validate_record(make_other())

    def test_planning_passes(self) -> None:
        validate_record(
            {
                "agent_id": "550e8400-e29b-41d4-a716-446655440000",
                "behavior": "Planning",
                "client_ts_utc": 1_700_000_000_000,
                "goal": "Win the match",
                "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
                "schema_version": "1.0",
                "session_id": "session-001",
                "steps": [{"description": "Analyse data", "index": 0}],
            }
        )

    def test_reflecting_passes(self) -> None:
        validate_record(
            {
                "agent_id": "550e8400-e29b-41d4-a716-446655440000",
                "behavior": "Reflecting",
                "client_ts_utc": 1_700_000_000_000,
                "inputs": [],
                "output_payload": "conclusion",
                "record_id": "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
                "schema_version": "1.0",
                "session_id": "session-001",
            }
        )


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
# validate_record — size limit violations
# ---------------------------------------------------------------------------


class TestValidateRecordSizeLimits:
    def test_trigger_payload_summary_too_long(self) -> None:
        oversized = "x" * (SIZE_LIMITS["TRIGGER_PAYLOAD_SUMMARY"] + 1)
        with pytest.raises(ValidationError):
            validate_record(make_observing(trigger_payload_summary=oversized))

    def test_thinking_prompt_too_long(self) -> None:
        oversized = "x" * (SIZE_LIMITS["THINKING_PROMPT"] + 1)
        with pytest.raises(ValidationError):
            validate_record(make_thinking(prompt=oversized))

    def test_thinking_output_too_long(self) -> None:
        oversized = "x" * (SIZE_LIMITS["THINKING_OUTPUT"] + 1)
        with pytest.raises(ValidationError):
            validate_record(make_thinking(output_payload=oversized))

    def test_acting_parameters_too_large(self) -> None:
        big = {f"key{i}": "x" * 45 for i in range(400)}
        with pytest.raises(ValidationError):
            validate_record(make_acting(parameters=big))

    def test_other_data_too_large(self) -> None:
        big = {f"key{i}": "x" * 45 for i in range(400)}
        with pytest.raises(ValidationError):
            validate_record(make_other(data=big))


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
