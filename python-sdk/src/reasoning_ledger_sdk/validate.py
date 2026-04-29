from __future__ import annotations

import json
from typing import Any

from pydantic import ValidationError as PydanticValidationError

from .constants import SIZE_LIMITS
from .errors import ValidationError
from .generated.records import (
    ActingRecord,
    ObservingRecord,
    OtherRecord,
    ReasoningLedgerRecordSchemas,
    ThinkingRecord,
    ToolCallingRecord,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _json_byte_length(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _str_byte_length(value: str) -> int:
    return len(value.encode("utf-8"))


# ---------------------------------------------------------------------------
# validate_record
#
# Validates a *complete* record (after auto-fill) against:
#   1. The Pydantic schema from generated/records.py
#   2. Per-record total JSON size (64 KB)
#   3. Behavior-specific field size caps (§10.2)
#
# Raises ValidationError on the first violation. Called before any
# network call so the server is never reached with invalid data.
# ---------------------------------------------------------------------------


def validate_record(record: Any) -> None:
    # 1. Pydantic schema validation.
    try:
        parsed = ReasoningLedgerRecordSchemas.model_validate(record)
    except PydanticValidationError as exc:
        first = exc.errors()[0] if exc.errors() else {}
        field = ".".join(str(p) for p in first.get("loc", [])) or "unknown"
        reason = first.get("msg", "Schema validation failed")
        raise ValidationError(
            f"Record validation failed: {reason}",
            {"field": field, "reason": reason},
        ) from exc

    typed = parsed.root

    # 2. Per-record total JSON size.
    total_bytes = _json_byte_length(record)
    if total_bytes > SIZE_LIMITS["RECORD_JSON"]:
        kb = SIZE_LIMITS["RECORD_JSON"] // 1024
        raise ValidationError(
            f"Record exceeds {kb} KB size limit ({total_bytes} bytes)",
            {"field": "(record)", "reason": "total size exceeded"},
        )

    # 3. Behavior-specific field size caps.

    if isinstance(typed, ObservingRecord):
        tps_bytes = _str_byte_length(typed.trigger_payload_summary)
        limit = SIZE_LIMITS["TRIGGER_PAYLOAD_SUMMARY"]
        if tps_bytes > limit:
            raise ValidationError(
                f"trigger_payload_summary exceeds {limit} byte limit ({tps_bytes} bytes)",
                {"field": "trigger_payload_summary", "reason": "size exceeded"},
            )

    elif isinstance(typed, ToolCallingRecord):
        meta_bytes = _json_byte_length(typed.tool_meta)
        tool_meta_limit = SIZE_LIMITS["TOOL_META"]
        if meta_bytes > tool_meta_limit:
            kb = tool_meta_limit // 1024
            raise ValidationError(
                f"tool_meta exceeds {kb} KB limit ({meta_bytes} bytes)",
                {"field": "tool_meta", "reason": "size exceeded"},
            )
        inp_bytes = _json_byte_length(typed.input_payload)
        tool_input_limit = SIZE_LIMITS["TOOL_INPUT"]
        if inp_bytes > tool_input_limit:
            kb = tool_input_limit // 1024
            raise ValidationError(
                f"input_payload exceeds {kb} KB limit ({inp_bytes} bytes)",
                {"field": "input_payload", "reason": "size exceeded"},
            )
        out_bytes = _json_byte_length(typed.output_payload)
        tool_output_limit = SIZE_LIMITS["TOOL_OUTPUT"]
        if out_bytes > tool_output_limit:
            kb = tool_output_limit // 1024
            raise ValidationError(
                f"output_payload exceeds {kb} KB limit ({out_bytes} bytes)",
                {"field": "output_payload", "reason": "size exceeded"},
            )

    elif isinstance(typed, ThinkingRecord):
        prompt_bytes = _str_byte_length(typed.prompt)
        prompt_limit = SIZE_LIMITS["THINKING_PROMPT"]
        if prompt_bytes > prompt_limit:
            kb = prompt_limit // 1024
            raise ValidationError(
                f"prompt exceeds {kb} KB limit ({prompt_bytes} bytes)",
                {"field": "prompt", "reason": "size exceeded"},
            )
        out_bytes = _str_byte_length(typed.output_payload)
        output_limit = SIZE_LIMITS["THINKING_OUTPUT"]
        if out_bytes > output_limit:
            kb = output_limit // 1024
            raise ValidationError(
                f"output_payload exceeds {kb} KB limit ({out_bytes} bytes)",
                {"field": "output_payload", "reason": "size exceeded"},
            )

    elif isinstance(typed, ActingRecord):
        param_bytes = _json_byte_length(typed.parameters)
        param_limit = SIZE_LIMITS["ACTING_PARAMETERS"]
        if param_bytes > param_limit:
            kb = param_limit // 1024
            raise ValidationError(
                f"parameters exceeds {kb} KB limit ({param_bytes} bytes)",
                {"field": "parameters", "reason": "size exceeded"},
            )

    elif isinstance(typed, OtherRecord):
        data_bytes = _json_byte_length(typed.data)
        data_limit = SIZE_LIMITS["OTHER_DATA"]
        if data_bytes > data_limit:
            kb = data_limit // 1024
            raise ValidationError(
                f"data exceeds {kb} KB limit ({data_bytes} bytes)",
                {"field": "data", "reason": "size exceeded"},
            )

    # Planning and Reflecting have no extra field-level size caps beyond the
    # record total; tags/notes are capped by the Pydantic schema (max_length /
    # max_items) rather than byte limits.
    # ReflectingRecord.output_payload is covered by the 64 KB per-record limit.


# ---------------------------------------------------------------------------
# validate_batch
#
# Validates a batch of complete records:
#   1. Count <= 50
#   2. Total JSON size <= 1 MB
#   3. Each record passes validate_record
#
# Returns a list of ValidationError | None in submission order.
# None = valid; non-None = the error for that position.
# The batch-level checks (count, total size) raise immediately because
# they abort the entire batch.
# ---------------------------------------------------------------------------


def validate_batch(records: list[Any]) -> list[ValidationError | None]:
    if len(records) > 50:
        raise ValidationError(
            f"Batch exceeds 50-record limit ({len(records)} records)",
            {"field": "(batch)", "reason": "batch size exceeded"},
        )

    total_bytes = _json_byte_length(records)
    batch_limit = SIZE_LIMITS["BATCH_JSON"]
    if total_bytes > batch_limit:
        mb = batch_limit // (1024 * 1024)
        raise ValidationError(
            f"Batch exceeds {mb} MB size limit ({total_bytes} bytes)",
            {"field": "(batch)", "reason": "total batch size exceeded"},
        )

    results: list[ValidationError | None] = []
    for record in records:
        try:
            validate_record(record)
            results.append(None)
        except ValidationError as exc:
            results.append(exc)
        except Exception:
            results.append(ValidationError("Unexpected validation error", {}))

    return results
