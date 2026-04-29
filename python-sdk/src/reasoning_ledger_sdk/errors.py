# ---------------------------------------------------------------------------
# LedgerError — base class for all SDK errors.
# Partners may branch on the class hierarchy or on the stable `code` string.
# ---------------------------------------------------------------------------


class LedgerError(Exception):
    code: str
    details: dict[str, object] | None

    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, object] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


# ---------------------------------------------------------------------------
# Subclasses (§7.10)
# ---------------------------------------------------------------------------


class ValidationError(LedgerError):
    """Local schema check failed; the record never reached the network."""

    def __init__(self, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__("validation_failed", message, details)


class AuthError(LedgerError):
    """API key rejected or unknown to the server."""

    def __init__(self, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__("auth_invalid", message, details)


class RateLimitError(LedgerError):
    """Server returned a rate-limit signal."""

    def __init__(self, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__("rate_limited", message, details)


class NetworkError(LedgerError):
    """Request never reached the server after exhausting retries."""

    def __init__(self, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__("network_failed", message, details)


class ServerError(LedgerError):
    """Server returned a non-retryable 5xx."""

    def __init__(self, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__("server_5xx", message, details)


class IdempotencyConflictError(LedgerError):
    """The same record_id was previously submitted with a different body."""

    def __init__(self, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__("record_id_conflict", message, details)


class NotFoundError(LedgerError):
    """Lookup target does not exist or is not visible to the calling owner."""

    def __init__(self, message: str, details: dict[str, object] | None = None) -> None:
        super().__init__("not_found", message, details)
