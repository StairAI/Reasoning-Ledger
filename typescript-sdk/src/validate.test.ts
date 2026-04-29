import { describe, expect, test } from "vitest";
import { SIZE_LIMITS } from "./constants.js";
import { ValidationError } from "./errors.js";
import { validateBatch, validateRecord } from "./validate.js";

// ---------------------------------------------------------------------------
// Shared minimal valid record builders
// ---------------------------------------------------------------------------

function makeObserving(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
    behavior: "Observing",
    client_ts_utc: 1_700_000_000_000,
    record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    schema_version: "1.0",
    session_id: "session-001",
    trigger_description: "User sent a message",
    trigger_payload_summary: "Hello world",
    trigger_source: "webhook",
    trigger_type: "signal_trigger",
    ...overrides,
  };
}

function makeToolCalling(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
    behavior: "ToolCalling",
    client_ts_utc: 1_700_000_000_000,
    description: "Fetched weather data",
    input_payload: { city: "Paris" },
    output_payload: { temp: 20 },
    record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    schema_version: "1.0",
    session_id: "session-001",
    success: true,
    tool_meta: { category: "external_api", tool_id: "weather_api" },
    ...overrides,
  };
}

function makeThinking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
    behavior: "Thinking",
    client_ts_utc: 1_700_000_000_000,
    inputs: [],
    output_payload: "result",
    prompt: "What should I do?",
    record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    schema_version: "1.0",
    session_id: "session-001",
    ...overrides,
  };
}

function makeActing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action_summary: "Sent email",
    action_type: "email",
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
    behavior: "Acting",
    client_ts_utc: 1_700_000_000_000,
    dry_run: false,
    execution_status: "confirmed",
    parameters: {},
    record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    schema_version: "1.0",
    session_id: "session-001",
    target_system: "smtp",
    ...overrides,
  };
}

function makeOther(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
    behavior: "Other",
    client_ts_utc: 1_700_000_000_000,
    data: { key: "value" },
    label: "file_edit",
    record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    schema_version: "1.0",
    session_id: "session-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validateRecord — valid records
// ---------------------------------------------------------------------------

describe("validateRecord — valid records", () => {
  test("Observing passes", () => {
    expect(() => validateRecord(makeObserving())).not.toThrow();
  });

  test("ToolCalling passes", () => {
    expect(() => validateRecord(makeToolCalling())).not.toThrow();
  });

  test("Thinking passes", () => {
    expect(() => validateRecord(makeThinking())).not.toThrow();
  });

  test("Acting passes", () => {
    expect(() => validateRecord(makeActing())).not.toThrow();
  });

  test("Other passes", () => {
    expect(() => validateRecord(makeOther())).not.toThrow();
  });

  test("Planning passes", () => {
    expect(() =>
      validateRecord({
        agent_id: "550e8400-e29b-41d4-a716-446655440000",
        behavior: "Planning",
        client_ts_utc: 1_700_000_000_000,
        goal: "Win the match",
        record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        schema_version: "1.0",
        session_id: "session-001",
        steps: [{ description: "Analyse data", index: 0 }],
      }),
    ).not.toThrow();
  });

  test("Reflecting passes", () => {
    expect(() =>
      validateRecord({
        agent_id: "550e8400-e29b-41d4-a716-446655440000",
        behavior: "Reflecting",
        client_ts_utc: 1_700_000_000_000,
        inputs: [],
        output_payload: "conclusion",
        record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        schema_version: "1.0",
        session_id: "session-001",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateRecord — schema violations
// ---------------------------------------------------------------------------

describe("validateRecord — schema violations", () => {
  test("missing behavior throws ValidationError", () => {
    const record = makeObserving();
    delete record["behavior"];
    expect(() => validateRecord(record)).toThrow(ValidationError);
  });

  test("invalid behavior throws ValidationError", () => {
    expect(() => validateRecord(makeObserving({ behavior: "Flying" }))).toThrow(ValidationError);
  });

  test("missing session_id throws ValidationError", () => {
    const record = makeObserving();
    delete record["session_id"];
    expect(() => validateRecord(record)).toThrow(ValidationError);
  });

  test("non-integer client_ts_utc throws ValidationError", () => {
    expect(() => validateRecord(makeObserving({ client_ts_utc: 1.5 }))).toThrow(ValidationError);
  });

  test("invalid record_id (not UUID) throws ValidationError", () => {
    expect(() => validateRecord(makeObserving({ record_id: "not-a-uuid" }))).toThrow(
      ValidationError,
    );
  });

  test("missing required Observing field throws ValidationError", () => {
    const record = makeObserving();
    delete record["trigger_source"];
    expect(() => validateRecord(record)).toThrow(ValidationError);
  });

  test("error has code validation_failed", () => {
    const record = makeObserving();
    delete record["behavior"];
    let caught: unknown;
    try {
      validateRecord(record);
      expect.fail("should have thrown");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).code).toBe("validation_failed");
  });
});

// ---------------------------------------------------------------------------
// validateRecord — size limit violations
// ---------------------------------------------------------------------------

describe("validateRecord — size limit violations", () => {
  test("trigger_payload_summary exceeding limit throws ValidationError", () => {
    const oversized = "x".repeat(SIZE_LIMITS.TRIGGER_PAYLOAD_SUMMARY + 1);
    // The Zod schema caps trigger_payload_summary at maxLength 4096, which
    // catches it as a schema error (also a ValidationError).
    expect(() => validateRecord(makeObserving({ trigger_payload_summary: oversized }))).toThrow(
      ValidationError,
    );
  });

  test("Thinking prompt exceeding limit throws ValidationError", () => {
    const oversized = "x".repeat(SIZE_LIMITS.THINKING_PROMPT + 1);
    expect(() => validateRecord(makeThinking({ prompt: oversized }))).toThrow(ValidationError);
  });

  test("Thinking output_payload exceeding limit throws ValidationError", () => {
    const oversized = "x".repeat(SIZE_LIMITS.THINKING_OUTPUT + 1);
    expect(() => validateRecord(makeThinking({ output_payload: oversized }))).toThrow(
      ValidationError,
    );
  });

  test("Acting parameters exceeding limit throws ValidationError", () => {
    // Build an object whose JSON encoding exceeds 16 KB.
    const big = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`key${i}`, "x".repeat(45)]),
    );
    expect(() => validateRecord(makeActing({ parameters: big }))).toThrow(ValidationError);
  });

  test("Other data exceeding limit throws ValidationError", () => {
    const big = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`key${i}`, "x".repeat(45)]),
    );
    expect(() => validateRecord(makeOther({ data: big }))).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// validateBatch
// ---------------------------------------------------------------------------

describe(validateBatch, () => {
  test("empty array returns empty results", () => {
    const results = validateBatch([]);
    expect(results).toStrictEqual([]);
  });

  test("all valid records returns all nulls", () => {
    const results = validateBatch([makeObserving(), makeActing()]);
    expect(results).toStrictEqual([null, null]);
  });

  test("mixed valid/invalid returns null for valid, error for invalid", () => {
    const invalid = makeObserving();
    delete invalid["behavior"];
    const results = validateBatch([makeObserving(), invalid, makeActing()]);
    expect(results[0]).toBeNull();
    expect(results[1]).toBeInstanceOf(ValidationError);
    expect(results[2]).toBeNull();
  });

  test("batch with more than 50 records throws immediately", () => {
    const records = Array.from({ length: 51 }, () => makeObserving());
    expect(() => validateBatch(records)).toThrow(ValidationError);
  });

  test("error on batch overflow has code validation_failed", () => {
    const records = Array.from({ length: 51 }, () => makeObserving());
    let caught: unknown;
    try {
      validateBatch(records);
      expect.fail("should have thrown");
    } catch (error) {
      caught = error;
    }
    expect((caught as ValidationError).code).toBe("validation_failed");
  });
});
