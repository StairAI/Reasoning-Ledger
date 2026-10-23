import { describe, expect, test } from "vitest";
import { SIZE_LIMITS } from "./constants.js";
import { ValidationError } from "./errors.js";
import { validateBatch, validateRecord } from "./validate.js";

// ---------------------------------------------------------------------------
// Shared minimal valid record builders (schema 0.5)
// ---------------------------------------------------------------------------

const REF = { bytes: 5, media_type: "text/plain; charset=utf-8", sha256: "c".repeat(64) };
const OTHER_RECORD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

function base(behavior: string, executor = "det"): Record<string, unknown> {
  return {
    agent_id: "550e8400-e29b-41d4-a716-446655440000",
    behavior,
    client_ts_utc: 1_700_000_000_000,
    executor,
    record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    record_phase: "post_execution",
    schema_version: "0.5",
    session_id: "session-001",
  };
}

function makeObserving(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Observing"),
    trigger_description: "User sent a message",
    trigger_payload_summary: "Hello world",
    trigger_source: "webhook",
    trigger_type: "signal_trigger",
    ...overrides,
  };
}

function makeToolCalling(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("ToolCalling"),
    description: "Fetched weather data",
    input_payload: REF,
    outcome: "success",
    output_payload: REF,
    tool_meta: { name: "weather_api" },
    ...overrides,
  };
}

function makeThinking(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Thinking", "ai"),
    inputs: [{ input_payload: REF }],
    output_payload: REF,
    prompt: REF,
    ...overrides,
  };
}

function makeActing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Acting"),
    action_summary: "Sent email",
    action_type: "email.send",
    execution_status: "confirmed",
    outcome: "success",
    target_system: "smtp",
    ...overrides,
  };
}

function makeAttesting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Attesting", "human"),
    disposition: "approve",
    gate_kind: "manual-review",
    operator_id: "operator-1",
    outcome: "success",
    record_phase: "concurrent",
    written_by: { component: "review-ui", credential: "svc-review" },
    ...overrides,
  };
}

function makeEscalating(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Escalating", "ai"),
    asked: REF,
    kind: "permission",
    outcome: "success",
    record_phase: "concurrent",
    ...overrides,
  };
}

function makeDelegating(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Delegating", "ai"),
    goal: REF,
    kind: "spawn",
    outcome: "success",
    ...overrides,
  };
}

function makeMemorizing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Memorizing", "ai"),
    op: "add",
    outcome: "success",
    scope: "project",
    target: REF,
    ...overrides,
  };
}

function makeOther(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...base("Other"),
    data: { key: "value" },
    label: "file_edit",
    ...overrides,
  };
}

function validationErrorOf(record: unknown): ValidationError | undefined {
  try {
    validateRecord(record);
  } catch (error) {
    if (error instanceof ValidationError) {
      return error;
    }
    throw error;
  }
  return undefined;
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

  test("Acting passes, without parameters", () => {
    expect(() => validateRecord(makeActing())).not.toThrow();
  });

  test("Attesting passes", () => {
    expect(() => validateRecord(makeAttesting())).not.toThrow();
  });

  test("Escalating passes", () => {
    expect(() => validateRecord(makeEscalating())).not.toThrow();
  });

  test("Delegating passes", () => {
    expect(() => validateRecord(makeDelegating())).not.toThrow();
  });

  test("Memorizing passes", () => {
    expect(() => validateRecord(makeMemorizing())).not.toThrow();
  });

  test("Other passes", () => {
    expect(() => validateRecord(makeOther())).not.toThrow();
  });

  test("Reflecting passes", () => {
    expect(() =>
      validateRecord({
        ...base("Reflecting", "ai"),
        inputs: [],
        output_payload: REF,
      }),
    ).not.toThrow();
  });

  test("optional base fields pass", () => {
    expect(() =>
      validateRecord(
        makeObserving({
          classification: {
            alternatives: [{ behavior: "Other", confidence: 0.1 }],
            confidence: 0.9,
            mapper: "collector@0.3",
            source: "rule",
          },
          duration_ms: 12,
          error_type: "http.5xx",
          on_behalf_of_agent_id: OTHER_RECORD_ID,
          outcome: "failure",
          sources: [{ kind: "record", ref: OTHER_RECORD_ID }],
          verdict: { conclusion: "ok", decided_by: "rule" },
          written_by: { component: "collector", credential: "svc-collector" },
        }),
      ),
    ).not.toThrow();
  });

  test.each(["human_trigger", "outcome_trigger", "agent_trigger"])(
    "Observing with trigger_type %s passes",
    (triggerType) => {
      expect(() => validateRecord(makeObserving({ trigger_type: triggerType }))).not.toThrow();
    },
  );

  test("ToolCalling passes with typed tool_meta, effect and extra tool_meta keys, without description", () => {
    const record = makeToolCalling({
      effect: "read",
      tool_meta: { call_id: "call-1", category: "weather", name: "get_weather", tool_type: "mcp" },
    });
    delete record["description"];
    expect(() => validateRecord(record)).not.toThrow();
  });

  test("Thinking passes without prompt and inputs, and with a plan", () => {
    expect(() =>
      validateRecord({
        ...base("Thinking", "ai"),
        output_payload: REF,
        revision_of: OTHER_RECORD_ID,
        steps: [
          { description: "Read the failing test", index: 0 },
          { depends_on: [0], description: "Fix the parser", index: 1 },
        ],
      }),
    ).not.toThrow();
  });

  test("Acting passes with execution_status cancelled and outcome cancelled", () => {
    expect(() =>
      validateRecord(makeActing({ execution_status: "cancelled", outcome: "cancelled" })),
    ).not.toThrow();
  });

  test("Reflecting, Attesting and Other pass with their new optional fields", () => {
    expect(() =>
      validateRecord({
        ...base("Reflecting", "det"),
        inputs: [],
        kind: "settlement",
        output_payload: REF,
      }),
    ).not.toThrow();
    expect(() =>
      validateRecord(makeAttesting({ channel: "async", seen_completeness: "partial" })),
    ).not.toThrow();
    expect(() =>
      validateRecord(makeOther({ label: "context.compaction", proposed_behavior: "Compacting" })),
    ).not.toThrow();
  });

  test("the new behaviours pass with their optional fields", () => {
    expect(() =>
      validateRecord(makeEscalating({ default: "allow once", options: ["allow once", "deny"] })),
    ).not.toThrow();
    expect(() =>
      validateRecord(
        makeDelegating({
          awaited: true,
          child_session_id: "session-002",
          delegate_agent_id: "code-reviewer",
          result: REF,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateRecord(makeMemorizing({ approved_by: OTHER_RECORD_ID, op: "delete" })),
    ).not.toThrow();
  });

  test("model_invocation: a live call and a replay without provider or model", () => {
    expect(() =>
      validateRecord(
        makeObserving({
          model_invocation: {
            cache_creation_tokens: 0,
            cache_read_tokens: 1200,
            invocation_kind: "live",
            model_name: "m",
            provider: "p",
            request_id: "req-1",
          },
        }),
      ),
    ).not.toThrow();
    for (const replayOf of [OTHER_RECORD_ID, REF]) {
      expect(() =>
        validateRecord(
          makeObserving({
            model_invocation: {
              invocation_kind: "replay",
              model_name: null,
              provider: null,
              replay_of: replayOf,
            },
          }),
        ),
      ).not.toThrow();
    }
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

  test.each(["executor", "record_phase"])("missing %s throws, naming the field", (field) => {
    const record = Object.fromEntries(
      Object.entries(makeObserving()).filter(([key]) => key !== field),
    );
    expect(validationErrorOf(record)?.details).toHaveProperty("field", field);
  });

  test("ToolCalling requires outcome (success is gone)", () => {
    const record = makeToolCalling({ success: true });
    delete record["outcome"];
    expect(validationErrorOf(record)?.details).toHaveProperty("field", "outcome");
  });

  test("Planning (schema 0.4) is no longer a behaviour: rejected, naming behavior", () => {
    const error = validationErrorOf({
      ...base("Planning", "ai"),
      goal: "Win the match",
      steps: [{ description: "Analyse data", index: 0 }],
    });
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.details).toHaveProperty("field", "behavior");
  });

  test.each([
    ["Acting", makeActing],
    ["Attesting", makeAttesting],
    ["Escalating", makeEscalating],
    ["Delegating", makeDelegating],
    ["Memorizing", makeMemorizing],
  ])("%s requires outcome", (_behavior, make) => {
    const record = make();
    delete record["outcome"];
    expect(validationErrorOf(record)?.details).toHaveProperty("field", "outcome");
  });

  test.each([
    ["Escalating", "asked", makeEscalating],
    ["Escalating", "kind", makeEscalating],
    ["Delegating", "goal", makeDelegating],
    ["Delegating", "kind", makeDelegating],
    ["Memorizing", "target", makeMemorizing],
    ["Memorizing", "scope", makeMemorizing],
    ["Memorizing", "op", makeMemorizing],
  ])("%s without %s is rejected, naming the field", (_behavior, field, make) => {
    const record = Object.fromEntries(Object.entries(make()).filter(([key]) => key !== field));
    expect(validationErrorOf(record)?.details).toHaveProperty("field", field);
  });

  test.each(["email", "Email.Send", "email.", "email send"])(
    "Acting.action_type %j is not a namespaced <domain>.<verb>",
    (actionType) => {
      expect(validationErrorOf(makeActing({ action_type: actionType }))?.details).toHaveProperty(
        "field",
        "action_type",
      );
    },
  );

  test("tool_meta needs a name", () => {
    expect(
      validationErrorOf(makeToolCalling({ tool_meta: { tool_id: "weather_api" } }))?.details,
    ).toHaveProperty("field", "tool_meta.name");
  });

  test("verdict.decided_by must be one of the fixed values", () => {
    expect(
      validationErrorOf(makeObserving({ verdict: { conclusion: "ok", decided_by: "rule-7" } }))
        ?.details,
    ).toHaveProperty("field", "verdict.decided_by");
  });

  test("raw text at a content position is not a ContentRef", () => {
    expect(validationErrorOf(makeThinking({ prompt: "raw text" }))?.details).toHaveProperty(
      "field",
      "prompt",
    );
  });

  test("Attesting requires executor human", () => {
    expect(validationErrorOf(makeAttesting({ executor: "ai" }))?.details).toHaveProperty(
      "field",
      "executor",
    );
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
// validateRecord — cross-field rules
// ---------------------------------------------------------------------------

describe("validateRecord — cross-field rules", () => {
  test("Acting on public-chain with execution_status confirmed requires execution_id", () => {
    const error = validationErrorOf(makeActing({ target_system: "public-chain" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.details).toHaveProperty("field", "execution_id");
  });

  test("Acting on public-chain passes with an execution_id, or when not confirmed", () => {
    expect(() =>
      validateRecord(makeActing({ execution_id: "0xabc", target_system: "public-chain" })),
    ).not.toThrow();
    expect(() =>
      validateRecord(makeActing({ execution_status: "pending", target_system: "public-chain" })),
    ).not.toThrow();
  });

  test("Attesting with disposition reject requires reason", () => {
    const error = validationErrorOf(makeAttesting({ disposition: "reject" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.details).toHaveProperty("field", "reason");
  });

  test("Attesting reject passes with a reason; approve and edit need none", () => {
    expect(() =>
      validateRecord(makeAttesting({ disposition: "reject", reason: "over budget" })),
    ).not.toThrow();
    expect(() =>
      validateRecord(makeAttesting({ disposition: "edit", patch: { amount: 10 } })),
    ).not.toThrow();
  });

  test.each([
    ["no_response", "timeout"],
    ["cancel", "cancelled"],
  ])("Attesting with disposition %s requires outcome %s", (disposition, outcome) => {
    const error = validationErrorOf(makeAttesting({ disposition, outcome: "success" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error?.message).toBe(
      `outcome must be '${outcome}' when disposition is '${disposition}'`,
    );
    expect(error?.details).toHaveProperty("field", "outcome");
    expect(() => validateRecord(makeAttesting({ disposition, outcome }))).not.toThrow();
  });

  test("validateBatch reports a rule violation for that record only", () => {
    const results = validateBatch([makeAttesting({ disposition: "reject" }), makeActing()]);
    expect(results[0]?.details).toHaveProperty("field", "reason");
    expect(results[1]).toBeNull();
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

  test("tool_meta exceeding limit throws ValidationError", () => {
    const big = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`key${i}`, "x".repeat(45)]),
    );
    expect(
      validationErrorOf(makeToolCalling({ tool_meta: { ...big, name: "big" } }))?.details,
    ).toHaveProperty("field", "tool_meta");
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

  test("content positions have no SDK size limit: they hold content references", () => {
    for (const key of ["THINKING_PROMPT", "THINKING_OUTPUT", "TOOL_INPUT", "TOOL_OUTPUT"]) {
      expect(SIZE_LIMITS).not.toHaveProperty(key);
    }
  });

  test("a value that JSON cannot encode is a ValidationError, not a TypeError", () => {
    expect(() => validateRecord(makeOther({ data: { n: 10n } }))).toThrow(ValidationError);
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
