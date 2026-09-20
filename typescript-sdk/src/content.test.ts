import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  BYTES_MEDIA_TYPE,
  JSON_MEDIA_TYPE,
  TEXT_MEDIA_TYPE,
  encodeContent,
  isContentRef,
  prepareContent,
} from "./content.js";
import { ValidationError } from "./errors.js";
import type { ContentRef } from "./generated/records.js";

// ---------------------------------------------------------------------------
// Fixtures (module scope so consistent-function-scoping is satisfied)
// ---------------------------------------------------------------------------

const REF: ContentRef = { bytes: 5, media_type: "text/plain", sha256: "a".repeat(64) };
const RECORD_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

const circular: Record<string, unknown> = {};
circular["self"] = circular;
const notJson = (): number => 1;

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function refOf(data: Uint8Array, mediaType: string): ContentRef {
  return {
    bytes: data.byteLength,
    media_type: mediaType,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function textRef(text: string): ContentRef {
  return refOf(utf8(text), TEXT_MEDIA_TYPE);
}

function jsonRef(value: unknown): ContentRef {
  return refOf(utf8(JSON.stringify(value)), JSON_MEDIA_TYPE);
}

// ---------------------------------------------------------------------------
// isContentRef
// ---------------------------------------------------------------------------

describe(isContentRef, () => {
  test("accepts an object whose keys are exactly sha256, bytes and media_type", () => {
    expect(isContentRef(REF)).toBeTruthy();
    expect(isContentRef({ bytes: 0, media_type: "x", sha256: "0".repeat(64) })).toBeTruthy();
  });

  test.each([
    ["an extra key", { ...REF, note: "x" }],
    ["a missing key", { bytes: 5, sha256: REF.sha256 }],
    ["uppercase hex", { ...REF, sha256: "A".repeat(64) }],
    ["a short hash", { ...REF, sha256: "a".repeat(63) }],
    ["negative bytes", { ...REF, bytes: -1 }],
    ["fractional bytes", { ...REF, bytes: 1.5 }],
    ["bytes given as a string", { ...REF, bytes: "5" }],
    ["a non-string media_type", { ...REF, media_type: 1 }],
    ["null", null],
    ["a string", REF.sha256],
    ["an array", [REF]],
    ["a Uint8Array", new Uint8Array(3)],
  ])("rejects %s", (_label, value) => {
    expect(isContentRef(value)).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// encodeContent
// ---------------------------------------------------------------------------

describe(encodeContent, () => {
  test("a string is UTF-8 encoded as text/plain; charset=utf-8", () => {
    expect(encodeContent("héllo", "prompt")).toStrictEqual({
      data: utf8("héllo"),
      mediaType: "text/plain; charset=utf-8",
    });
  });

  test("bytes are sent as they are, as application/octet-stream", () => {
    const bytes = new Uint8Array([0, 255, 1]);
    const encoded = encodeContent(bytes, "input_payload");
    expect(encoded.data).toBe(bytes);
    expect(encoded.mediaType).toBe(BYTES_MEDIA_TYPE);
  });

  test.each([
    [{ n: 1, query: "cross-sdk" }, '{"n":1,"query":"cross-sdk"}'],
    [[1, "two", { three: 3 }], '[1,"two",{"three":3}]'],
    [42, "42"],
    [true, "true"],
    [null, "null"],
  ])("%j is JSON-encoded compactly as application/json", (value, json) => {
    expect(encodeContent(value, "input_payload")).toStrictEqual({
      data: utf8(json),
      mediaType: "application/json",
    });
  });

  test.each([
    ["a BigInt", 10n],
    ["a function", notJson],
    ["a symbol", Symbol("x")],
    ["a circular object", circular],
  ])("%s cannot be uploaded: ValidationError naming the field", (_label, value) => {
    let caught: unknown;
    try {
      encodeContent(value, "output_payload");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toHaveProperty("field", "output_payload");
  });
});

// ---------------------------------------------------------------------------
// prepareContent — content positions
// ---------------------------------------------------------------------------

describe(prepareContent, () => {
  test("ToolCalling: input_payload and output_payload", () => {
    const { record, uploads } = prepareContent({
      behavior: "ToolCalling",
      input_payload: { n: 1, query: "cross-sdk" },
      output_payload: "done",
      tool_meta: { name: "echo" },
    });
    expect(record["input_payload"]).toStrictEqual(jsonRef({ n: 1, query: "cross-sdk" }));
    expect(record["output_payload"]).toStrictEqual(textRef("done"));
    expect(record["tool_meta"]).toStrictEqual({ name: "echo" });
    expect(uploads.map((upload) => upload.ref)).toStrictEqual([
      jsonRef({ n: 1, query: "cross-sdk" }),
      textRef("done"),
    ]);
  });

  test("Thinking: prompt, output_payload, inputs[].input_payload and internal_reasoning", () => {
    const { record, uploads } = prepareContent({
      behavior: "Thinking",
      inputs: [{ input_payload: "echo ok", input_record_id: RECORD_ID }, { input_payload: REF }],
      model_invocation: { internal_reasoning: "because", model_name: "m", provider: "p" },
      output_payload: "Yes",
      prompt: "Should we act?",
    });
    expect(record["prompt"]).toStrictEqual(textRef("Should we act?"));
    expect(record["output_payload"]).toStrictEqual(textRef("Yes"));
    expect(record["inputs"]).toStrictEqual([
      { input_payload: textRef("echo ok"), input_record_id: RECORD_ID },
      { input_payload: REF },
    ]);
    expect(record["model_invocation"]).toStrictEqual({
      internal_reasoning: textRef("because"),
      model_name: "m",
      provider: "p",
    });
    expect(uploads).toHaveLength(4);
  });

  test("Reflecting: output_payload and inputs[].input_payload", () => {
    const { record, uploads } = prepareContent({
      behavior: "Reflecting",
      inputs: [{ input_payload: [1, 2] }],
      output_payload: new Uint8Array([9]),
    });
    expect(record["inputs"]).toStrictEqual([{ input_payload: jsonRef([1, 2]) }]);
    expect(record["output_payload"]).toStrictEqual(refOf(new Uint8Array([9]), BYTES_MEDIA_TYPE));
    expect(uploads).toHaveLength(2);
  });

  test("Attesting: effects is uploaded; evidence_refs are left as given", () => {
    const evidence = [RECORD_ID, REF, { note: "not a ref" }];
    const { record, uploads } = prepareContent({
      behavior: "Attesting",
      effects: { rules_changed: 1 },
      evidence_refs: evidence,
    });
    expect(record["effects"]).toStrictEqual(jsonRef({ rules_changed: 1 }));
    expect(record["evidence_refs"]).toBe(evidence);
    expect(uploads).toHaveLength(1);
  });

  test("other behaviours only have model_invocation.internal_reasoning", () => {
    const parameters = { prompt: "not content" };
    const { record, uploads } = prepareContent({
      behavior: "Acting",
      model_invocation: { internal_reasoning: "why", model_name: "m", provider: "p" },
      parameters,
    });
    expect(record["parameters"]).toBe(parameters);
    expect(uploads.map((upload) => upload.ref)).toStrictEqual([textRef("why")]);
  });

  test("ContentRefs and absent positions are left alone", () => {
    const { record, uploads } = prepareContent({
      behavior: "ToolCalling",
      input_payload: REF,
    });
    expect(record["input_payload"]).toBe(REF);
    expect(record).not.toHaveProperty("output_payload");
    expect(uploads).toStrictEqual([]);
  });

  test("the input record is not modified", () => {
    const invocation = { internal_reasoning: "why", model_name: "m", provider: "p" };
    const inputs = [{ input_payload: "raw" }];
    const input = {
      behavior: "Thinking",
      inputs,
      model_invocation: invocation,
      output_payload: "out",
      prompt: "in",
    };
    prepareContent(input);
    expect(input.prompt).toBe("in");
    expect(inputs[0]?.input_payload).toBe("raw");
    expect(invocation.internal_reasoning).toBe("why");
  });
});
