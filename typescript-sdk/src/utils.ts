import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Public utilities (§7.7).
// ---------------------------------------------------------------------------

/**
 * Generate a fresh UUID v4 suitable for use as a `record_id`.
 * Use when constructing dependency edges where a child needs to reference
 * an as-yet-unsubmitted record.
 */
export function newRecordId(): string {
  return randomUUID();
}

/**
 * Returns the current time as an integer epoch-millisecond.
 * Used internally whenever `client_ts_utc` is omitted on a submitted record.
 */
export function nowEpochMs(): number {
  return Date.now();
}

/**
 * Returns true iff `value` is a syntactically valid UUID v4.
 * Useful for validating record IDs read from external systems before
 * passing them to `upstream_record_id`, `parent_record_id`, or
 * `input_record_id`.
 */
export function isValidRecordId(value: string): boolean {
  return /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(value);
}
