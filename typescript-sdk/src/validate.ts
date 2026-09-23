import type { z } from "zod";

import {
  ActingRecord,
  AttestingRecord,
  BehaviorType,
  Record as LedgerRecord,
  ObservingRecord,
  OtherRecord,
  PlanningRecord,
  ReflectingRecord,
  ThinkingRecord,
  ToolCallingRecord,
} from "./generated/records.js";
import { SIZE_LIMITS } from "./constants.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_BATCH_RECORDS = 50;

function jsonByteLength(value: unknown, field: string): number {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`${field} is not JSON-serializable: ${reason}`, { field, reason });
  }
  return Buffer.byteLength(json, "utf-8");
}

function jsonStringByteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function tooLarge(field: string, limit: number, bytes: number): ValidationError {
  const size = limit % 1024 === 0 ? `${limit / 1024} KB` : `${limit} byte`;
  return new ValidationError(`${field} exceeds ${size} limit (${bytes} bytes)`, {
    field,
    reason: "size exceeded",
  });
}

// ---------------------------------------------------------------------------
// Schema check. Each record is parsed with its own behaviour's generated
// schema rather than the union, so a failure names the offending field
// instead of a bare "Invalid input".
// ---------------------------------------------------------------------------

const SCHEMAS: Record<BehaviorType, z.ZodType> = {
  Acting: ActingRecord,
  Attesting: AttestingRecord,
  Observing: ObservingRecord,
  Other: OtherRecord,
  Planning: PlanningRecord,
  Reflecting: ReflectingRecord,
  Thinking: ThinkingRecord,
  ToolCalling: ToolCallingRecord,
};

function schemaFor(record: unknown): z.ZodType {
  const behavior =
    typeof record === "object" && record !== null
      ? BehaviorType.safeParse((record as Record<string, unknown>)["behavior"])
      : undefined;
  return behavior?.success ? SCHEMAS[behavior.data] : LedgerRecord;
}

function parseRecord(record: unknown): Record<string, unknown> {
  const result = schemaFor(record).safeParse(record);
  if (!result.success) {
    const [first] = result.error.issues;
    const field = first?.path.join(".") ?? "unknown";
    const reason = first?.message ?? "Schema validation failed";
    const where = field.length > 0 ? ` at ${field}` : "";
    throw new ValidationError(`Record validation failed${where}: ${reason}`, { field, reason });
  }
  return result.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Cross-field rules — the schema's if/then rules, which the generated zod
// schemas do not carry. Same rules and wording as the server.
// ---------------------------------------------------------------------------

function checkRules(record: Record<string, unknown>): void {
  if (
    record["behavior"] === "Acting" &&
    record["target_system"] === "public-chain" &&
    record["execution_status"] === "confirmed" &&
    !record["execution_id"]
  ) {
    throw new ValidationError(
      "execution_id is required when target_system is 'public-chain' and execution_status is 'confirmed'",
      {
        field: "execution_id",
        reason: "required when target_system is 'public-chain' and execution_status is 'confirmed'",
      },
    );
  }
  if (
    record["behavior"] === "Attesting" &&
    record["disposition"] === "reject" &&
    !record["reason"]
  ) {
    throw new ValidationError("reason is required when disposition is 'reject'", {
      field: "reason",
      reason: "required when disposition is 'reject'",
    });
  }
}

// ---------------------------------------------------------------------------
// Size caps (§10.2). Content positions hold content references; the size of
// the content itself is enforced by the server on upload.
// ---------------------------------------------------------------------------

const FIELD_CAPS: Partial<Record<string, { field: string; limit: number }>> = {
  Acting: { field: "parameters", limit: SIZE_LIMITS.ACTING_PARAMETERS },
  Other: { field: "data", limit: SIZE_LIMITS.OTHER_DATA },
  ToolCalling: { field: "tool_meta", limit: SIZE_LIMITS.TOOL_META },
};

function checkSizes(record: unknown, parsed: Record<string, unknown>): void {
  const totalBytes = jsonByteLength(record, "(record)");
  if (totalBytes > SIZE_LIMITS.RECORD_JSON) {
    throw new ValidationError(
      `Record exceeds ${SIZE_LIMITS.RECORD_JSON / 1024} KB size limit (${totalBytes} bytes)`,
      { field: "(record)", reason: "total size exceeded" },
    );
  }

  const { behavior, trigger_payload_summary: summary } = parsed;
  if (behavior === "Observing" && typeof summary === "string") {
    const bytes = jsonStringByteLength(summary);
    if (bytes > SIZE_LIMITS.TRIGGER_PAYLOAD_SUMMARY) {
      throw tooLarge("trigger_payload_summary", SIZE_LIMITS.TRIGGER_PAYLOAD_SUMMARY, bytes);
    }
  }

  const cap = typeof behavior === "string" ? FIELD_CAPS[behavior] : undefined;
  if (cap !== undefined) {
    const bytes = jsonByteLength(parsed[cap.field], cap.field);
    if (bytes > cap.limit) {
      throw tooLarge(cap.field, cap.limit, bytes);
    }
  }
}

// ---------------------------------------------------------------------------
// validateRecord
//
// Validates a *complete* record (after auto-fill, with ContentRefs at every
// content position) against:
//   1. The generated zod schema for its behaviour
//   2. The cross-field rules (Acting on public-chain; Attesting reject)
//   3. Per-record total JSON size (64 KB) and behavior-specific field caps
//
// Throws ValidationError on the first violation. Called before any
// network call so the server is never reached with invalid data.
// ---------------------------------------------------------------------------

export function validateRecord(record: unknown): void {
  const parsed = parseRecord(record);
  checkRules(parsed);
  checkSizes(record, parsed);
}

// ---------------------------------------------------------------------------
// validateBatch
//
// Validates a batch of complete records:
//   1. Count ≤ 50
//   2. Each record passes validateRecord
//   3. Total JSON size of the valid records (those that will be sent) ≤ 1 MB
//
// Returns an array of ValidationError | null in submission order.
// null = valid; non-null = the error for that position.
// The batch-level checks (count, total size) throw because they abort the
// entire batch.
// ---------------------------------------------------------------------------

export function validateBatch(records: unknown[]): (ValidationError | null)[] {
  if (records.length > MAX_BATCH_RECORDS) {
    throw new ValidationError(
      `Batch exceeds ${MAX_BATCH_RECORDS}-record limit (${records.length} records)`,
      { field: "(batch)", reason: "batch size exceeded" },
    );
  }

  const errors = records.map((record) => {
    try {
      validateRecord(record);
      return null;
    } catch (error) {
      if (error instanceof ValidationError) {
        return error;
      }
      return new ValidationError("Unexpected validation error", {});
    }
  });

  const totalBytes = jsonByteLength(
    records.filter((_, i) => errors[i] === null),
    "(batch)",
  );
  if (totalBytes > SIZE_LIMITS.BATCH_JSON) {
    throw new ValidationError(
      `Batch exceeds ${SIZE_LIMITS.BATCH_JSON / (1024 * 1024)} MB size limit (${totalBytes} bytes)`,
      { field: "(batch)", reason: "total batch size exceeded" },
    );
  }

  return errors;
}
