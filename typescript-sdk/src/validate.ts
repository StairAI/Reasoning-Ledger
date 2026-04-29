import { Record as LedgerRecord } from "./generated/records.js";
import { SIZE_LIMITS } from "./constants.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf-8");
}

function jsonStringByteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

// ---------------------------------------------------------------------------
// validateRecord
//
// Validates a *complete* record (after auto-fill) against:
//   1. The Zod schema from generated/records.ts
//   2. Per-record total JSON size (64 KB)
//   3. Behavior-specific field size caps (§10.2)
//
// Throws ValidationError on the first violation. Called before any
// network call so the server is never reached with invalid data.
// ---------------------------------------------------------------------------

export function validateRecord(record: unknown): void {
  // 1. Zod schema validation.
  const result = LedgerRecord.safeParse(record);
  if (!result.success) {
    const [first] = result.error.issues;
    const field = first?.path.join(".") ?? "unknown";
    const reason = first?.message ?? "Schema validation failed";
    throw new ValidationError(`Record validation failed: ${reason}`, {
      field,
      reason,
    });
  }

  const parsed = result.data;

  // 2. Per-record total JSON size.
  const totalBytes = jsonByteLength(record);
  if (totalBytes > SIZE_LIMITS.RECORD_JSON) {
    throw new ValidationError(
      `Record exceeds ${SIZE_LIMITS.RECORD_JSON / 1024} KB size limit (${totalBytes} bytes)`,
      { field: "(record)", reason: "total size exceeded" },
    );
  }

  // 3. Behavior-specific field size caps.
  switch (parsed.behavior) {
    case "Observing": {
      const bytes = jsonStringByteLength(parsed.trigger_payload_summary);
      if (bytes > SIZE_LIMITS.TRIGGER_PAYLOAD_SUMMARY) {
        throw new ValidationError(
          `trigger_payload_summary exceeds ${SIZE_LIMITS.TRIGGER_PAYLOAD_SUMMARY} byte limit (${bytes} bytes)`,
          { field: "trigger_payload_summary", reason: "size exceeded" },
        );
      }
      break;
    }

    case "ToolCalling": {
      const metaBytes = jsonByteLength(parsed.tool_meta);
      if (metaBytes > SIZE_LIMITS.TOOL_META) {
        throw new ValidationError(
          `tool_meta exceeds ${SIZE_LIMITS.TOOL_META / 1024} KB limit (${metaBytes} bytes)`,
          { field: "tool_meta", reason: "size exceeded" },
        );
      }
      const inputBytes = jsonByteLength(parsed.input_payload);
      if (inputBytes > SIZE_LIMITS.TOOL_INPUT) {
        throw new ValidationError(
          `input_payload exceeds ${SIZE_LIMITS.TOOL_INPUT / 1024} KB limit (${inputBytes} bytes)`,
          { field: "input_payload", reason: "size exceeded" },
        );
      }
      const outputBytes = jsonByteLength(parsed.output_payload);
      if (outputBytes > SIZE_LIMITS.TOOL_OUTPUT) {
        throw new ValidationError(
          `output_payload exceeds ${SIZE_LIMITS.TOOL_OUTPUT / 1024} KB limit (${outputBytes} bytes)`,
          { field: "output_payload", reason: "size exceeded" },
        );
      }
      break;
    }

    case "Thinking": {
      const promptBytes = jsonStringByteLength(parsed.prompt);
      if (promptBytes > SIZE_LIMITS.THINKING_PROMPT) {
        throw new ValidationError(
          `prompt exceeds ${SIZE_LIMITS.THINKING_PROMPT / 1024} KB limit (${promptBytes} bytes)`,
          { field: "prompt", reason: "size exceeded" },
        );
      }
      const outputBytes = jsonStringByteLength(parsed.output_payload);
      if (outputBytes > SIZE_LIMITS.THINKING_OUTPUT) {
        throw new ValidationError(
          `output_payload exceeds ${SIZE_LIMITS.THINKING_OUTPUT / 1024} KB limit (${outputBytes} bytes)`,
          { field: "output_payload", reason: "size exceeded" },
        );
      }
      break;
    }

    case "Acting": {
      const paramBytes = jsonByteLength(parsed.parameters);
      if (paramBytes > SIZE_LIMITS.ACTING_PARAMETERS) {
        throw new ValidationError(
          `parameters exceeds ${SIZE_LIMITS.ACTING_PARAMETERS / 1024} KB limit (${paramBytes} bytes)`,
          { field: "parameters", reason: "size exceeded" },
        );
      }
      break;
    }

    case "Other": {
      const dataBytes = jsonByteLength(parsed.data);
      if (dataBytes > SIZE_LIMITS.OTHER_DATA) {
        throw new ValidationError(
          `data exceeds ${SIZE_LIMITS.OTHER_DATA / 1024} KB limit (${dataBytes} bytes)`,
          { field: "data", reason: "size exceeded" },
        );
      }
      break;
    }

    // Planning and Reflecting have no extra field-level size caps beyond the
    // record total, and tags / notes are capped by the Zod schema (maxLength /
    // maxItems) rather than byte limits.
    default: {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// validateBatch
//
// Validates a batch of complete records:
//   1. Count ≤ 50
//   2. Total JSON size ≤ 1 MB
//   3. Each record passes validateRecord
//
// Returns an array of ValidationError | null in submission order.
// null = valid; non-null = the error for that position.
// The batch-level checks (count, total size) throw immediately because
// they abort the entire batch.
// ---------------------------------------------------------------------------

export function validateBatch(records: unknown[]): (ValidationError | null)[] {
  if (records.length > 50) {
    throw new ValidationError(`Batch exceeds 50-record limit (${records.length} records)`, {
      field: "(batch)",
      reason: "batch size exceeded",
    });
  }

  const totalBytes = jsonByteLength(records);
  if (totalBytes > SIZE_LIMITS.BATCH_JSON) {
    throw new ValidationError(
      `Batch exceeds ${SIZE_LIMITS.BATCH_JSON / (1024 * 1024)} MB size limit (${totalBytes} bytes)`,
      { field: "(batch)", reason: "total batch size exceeded" },
    );
  }

  return records.map((record) => {
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
}
