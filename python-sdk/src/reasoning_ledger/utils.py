import re
import time
import uuid

# ---------------------------------------------------------------------------
# Public utilities (§7.7).
# ---------------------------------------------------------------------------


def new_record_id() -> str:
    """Generate a fresh UUID v4 suitable for use as a record_id."""
    return str(uuid.uuid4())


def now_epoch_ms() -> int:
    """Return the current time as an integer epoch-millisecond."""
    return int(time.time() * 1000)


_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def is_valid_record_id(value: str) -> bool:
    """Return True iff value is a syntactically valid UUID v4."""
    return bool(_UUID4_RE.match(value))
