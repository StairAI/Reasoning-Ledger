// ---------------------------------------------------------------------------
// LedgerError — base class for all SDK errors.
// Partners may branch on the class hierarchy or on the stable `code` string.
// ---------------------------------------------------------------------------

export class LedgerError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Subclasses (§7.10)
// ---------------------------------------------------------------------------

/**
 * Local schema check failed; the record never reached the network.
 * `details.field` and `details.reason` carry the specific violation.
 */
export class ValidationError extends LedgerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_failed", message, details);
    this.name = "ValidationError";
  }
}

/**
 * API key rejected or unknown to the server.
 */
export class AuthError extends LedgerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("auth_invalid", message, details);
    this.name = "AuthError";
  }
}

/**
 * Server returned a rate-limit signal.
 * `details.retry_after_ms` carries the suggested wait when available.
 */
export class RateLimitError extends LedgerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("rate_limited", message, details);
    this.name = "RateLimitError";
  }
}

/**
 * Request never reached the server after exhausting retries.
 */
export class NetworkError extends LedgerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("network_failed", message, details);
    this.name = "NetworkError";
  }
}

/**
 * Server returned a non-retryable 5xx.
 * `details.status` carries the HTTP status code.
 */
export class ServerError extends LedgerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("server_5xx", message, details);
    this.name = "ServerError";
  }
}

/**
 * The same `record_id` was previously submitted with a different body.
 */
export class IdempotencyConflictError extends LedgerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("record_id_conflict", message, details);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * Lookup target does not exist or is not visible to the calling owner.
 */
export class NotFoundError extends LedgerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, details);
    this.name = "NotFoundError";
  }
}
