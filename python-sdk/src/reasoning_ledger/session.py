from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .types import BatchAck, RecordAck, SubmitInput
from .utils import new_record_id

if TYPE_CHECKING:
    from .client import LedgerClient


# ---------------------------------------------------------------------------
# Session
#
# A lightweight wrapper that binds a session_id to a LedgerClient, so
# callers don't have to pass it on every record. Purely client-side sugar;
# no server-side session lifecycle exists.
# ---------------------------------------------------------------------------


class Session:
    """A session bound to a specific session_id."""

    def __init__(self, client: LedgerClient, session_id: str | None = None) -> None:
        self._client = client
        self.id: str = session_id if session_id is not None else new_record_id()

    def submit(self, input_record: dict[str, Any]) -> RecordAck:
        """Submit a single record, auto-injecting session_id = self.id."""
        return self._client._submit({**input_record, "session_id": self.id})

    def submit_batch(self, inputs: list[SubmitInput]) -> BatchAck:
        """Submit a batch, auto-injecting session_id = self.id on each record."""
        return self._client._submit_batch(
            [{**inp, "session_id": self.id} for inp in inputs]
        )
