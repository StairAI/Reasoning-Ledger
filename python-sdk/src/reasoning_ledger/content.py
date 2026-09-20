"""
Content positions and raw-content encoding (schema 0.4).

Raw text never goes into a record: a content position holds a ContentRef
{sha256, bytes, media_type} pointing at bytes in the content library. In
submit(), submit_batch() and the Session submit methods a content position may
hold a raw value instead; the SDK encodes it as below, uploads it and puts the
returned ContentRef in its place. Both SDKs use the same encodings, so the same
text or bytes get the same hash; a JSON value hashes the same only if both
languages print it the same way (floats such as 1.0 may differ).
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .errors import ValidationError

TEXT_MEDIA_TYPE = "text/plain; charset=utf-8"
BINARY_MEDIA_TYPE = "application/octet-stream"
JSON_MEDIA_TYPE = "application/json"

_SHA256_HEX = re.compile(r"[0-9a-f]{64}")
_CONTENT_REF_KEYS = frozenset({"sha256", "bytes", "media_type"})

# Top-level content positions, by behavior.
_CONTENT_FIELDS: dict[str, tuple[str, ...]] = {
    "Attesting": ("effects",),
    "Reflecting": ("output_payload",),
    "Thinking": ("prompt", "output_payload"),
    "ToolCalling": ("input_payload", "output_payload"),
}
# Behaviors whose inputs[].input_payload is a content position.
_INPUT_BEHAVIORS = frozenset({"Reflecting", "Thinking"})


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_sha256_hex(value: object) -> bool:
    """True iff value is a string of 64 lowercase hex characters."""
    return isinstance(value, str) and _SHA256_HEX.fullmatch(value) is not None


def is_content_ref(value: Any) -> bool:
    """True iff value is a dict whose keys are exactly sha256 (64 lowercase hex),
    bytes (non-negative integer) and media_type (string)."""
    if not isinstance(value, dict) or value.keys() != _CONTENT_REF_KEYS:
        return False
    size = value["bytes"]
    return (
        is_sha256_hex(value["sha256"])
        and isinstance(size, int)
        and not isinstance(size, bool)
        and size >= 0
        and isinstance(value["media_type"], str)
    )


def encode_text_or_bytes(value: object, path: str) -> tuple[bytes, str] | None:
    """(raw bytes, default media type) for str or bytes; None for any other value."""
    if isinstance(value, bytes | bytearray | memoryview):
        return bytes(value), BINARY_MEDIA_TYPE
    if isinstance(value, str):
        return _utf8(value, path), TEXT_MEDIA_TYPE
    return None


def encode_content(value: object, path: str) -> tuple[bytes, str]:
    """(raw bytes, media type) for a raw value at a content position: str as
    UTF-8 text, bytes as is, any other JSON value as compact JSON."""
    encoded = encode_text_or_bytes(value, path)
    if encoded is not None:
        return encoded
    try:
        text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise ValidationError(
            f"{path} must be a ContentRef, str, bytes or JSON value; "
            f"{type(value).__name__} is not JSON-serializable",
            {"field": path, "reason": "not JSON-serializable"},
        ) from exc
    return _utf8(text, path), JSON_MEDIA_TYPE


def _utf8(text: str, path: str) -> bytes:
    try:
        return text.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValidationError(
            f"{path} is not valid Unicode text ({exc.reason})",
            {"field": path, "reason": "invalid text"},
        ) from exc


def content_slots(record: dict[str, Any]) -> list[tuple[dict[str, Any], str, str]]:
    """Every content position present in `record`, as (container, key, path).

    `record` must be the caller's own copy: nested containers holding content
    positions (inputs, model_invocation) are replaced by shallow copies here,
    so writing through a slot never touches objects the caller passed in.
    """
    behavior = record.get("behavior")
    if not isinstance(behavior, str):
        behavior = ""
    slots = [(record, key, key) for key in _CONTENT_FIELDS.get(behavior, ()) if key in record]

    inputs = record.get("inputs")
    if behavior in _INPUT_BEHAVIORS and isinstance(inputs, list):
        copied = [dict(item) if isinstance(item, dict) else item for item in inputs]
        record["inputs"] = copied
        for index, item in enumerate(copied):
            if isinstance(item, dict) and "input_payload" in item:
                slots.append((item, "input_payload", f"inputs.{index}.input_payload"))

    invocation = record.get("model_invocation")
    if isinstance(invocation, dict) and "internal_reasoning" in invocation:
        invocation = dict(invocation)
        record["model_invocation"] = invocation
        slots.append((invocation, "internal_reasoning", "model_invocation.internal_reasoning"))

    return slots
