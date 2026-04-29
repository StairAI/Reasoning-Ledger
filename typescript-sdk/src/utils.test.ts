import { describe, expect, test, expectTypeOf } from "vitest";
import { isValidRecordId, newRecordId, nowEpochMs } from "./utils.js";

// ---------------------------------------------------------------------------
// newRecordId
// ---------------------------------------------------------------------------

describe(newRecordId, () => {
  test("returns a string", () => {
    expectTypeOf(newRecordId()).toBeString();
  });

  test("returns a valid UUID v4 pattern", () => {
    const id = newRecordId();
    expect(id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  });

  test("returns a unique value on each call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRecordId()));
    expect(ids.size).toBe(100);
  });

  test("returns a value recognised by isValidRecordId", () => {
    expect(isValidRecordId(newRecordId())).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// nowEpochMs
// ---------------------------------------------------------------------------

describe(nowEpochMs, () => {
  test("returns a number", () => {
    expectTypeOf(nowEpochMs()).toBeNumber();
  });

  test("returns an integer", () => {
    expect(Number.isInteger(nowEpochMs())).toBeTruthy();
  });

  test("returns a positive value", () => {
    expect(nowEpochMs()).toBeGreaterThan(0);
  });

  test("is monotonically non-decreasing across two calls", () => {
    const a = nowEpochMs();
    const b = nowEpochMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test("is close to Date.now()", () => {
    const before = Date.now();
    const result = nowEpochMs();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// isValidRecordId
// ---------------------------------------------------------------------------

describe(isValidRecordId, () => {
  // Valid UUID v4 examples
  test.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  ])("returns true for valid UUID v4: %s", (id) => {
    expect(isValidRecordId(id)).toBeTruthy();
  });

  test("returns true for freshly generated record IDs", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(isValidRecordId(newRecordId())).toBeTruthy();
    }
  });

  test("returns false for empty string", () => {
    expect(isValidRecordId("")).toBeFalsy();
  });

  test("returns false for plain string", () => {
    expect(isValidRecordId("not-a-uuid")).toBeFalsy();
  });

  test("returns false for UUID v1 (version digit is 1)", () => {
    expect(isValidRecordId("550e8400-e29b-11d4-a716-446655440000")).toBeFalsy();
  });

  test("returns false for UUID without hyphens", () => {
    expect(isValidRecordId("550e8400e29b41d4a716446655440000")).toBeFalsy();
  });

  test("returns false for UUID with wrong variant digit", () => {
    // variant must be [89ab]; 'c' is invalid
    expect(isValidRecordId("550e8400-e29b-41d4-c716-446655440000")).toBeFalsy();
  });
});
