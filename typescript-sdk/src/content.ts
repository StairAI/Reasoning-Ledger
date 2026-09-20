import { createHash } from "node:crypto";

import { ValidationError } from "./errors.js";
import type { ContentRef } from "./generated/records.js";

// ---------------------------------------------------------------------------
// Media types for raw content (cross-SDK contract).
// ---------------------------------------------------------------------------

export const TEXT_MEDIA_TYPE = "text/plain; charset=utf-8";
export const BYTES_MEDIA_TYPE = "application/octet-stream";
export const JSON_MEDIA_TYPE = "application/json";

const SHA256_HEX = /^[\da-f]{64}$/;
const CONTENT_REF_KEYS = new Set(["bytes", "media_type", "sha256"]);
const encoder = new TextEncoder();

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True iff `value` is 64 lowercase hex characters. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** Lowercase hex SHA-256 of `data`. */
export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * True iff `value` is a ContentRef: an object whose keys are exactly `sha256`
 * (64 lowercase hex), `bytes` (a non-negative integer) and `media_type` (a
 * string). Anything else at a content position is raw content.
 */
export function isContentRef(value: unknown): value is ContentRef {
  if (!isObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const { bytes, media_type: mediaType, sha256 } = value;
  return (
    keys.length === CONTENT_REF_KEYS.size &&
    keys.every((key) => CONTENT_REF_KEYS.has(key)) &&
    isSha256Hex(sha256) &&
    typeof bytes === "number" &&
    Number.isInteger(bytes) &&
    bytes >= 0 &&
    typeof mediaType === "string"
  );
}

// ---------------------------------------------------------------------------
// encodeContent — raw content → bytes + media type.
// ---------------------------------------------------------------------------

export interface EncodedContent {
  data: Uint8Array;
  mediaType: string;
}

function notEncodable(field: string, reason: string): ValidationError {
  return new ValidationError(`${field} cannot be uploaded as content: ${reason}`, {
    field,
    reason,
  });
}

/**
 * Encode raw content as the contract prescribes: a string as UTF-8 text, a
 * Uint8Array as is, any other value as compact JSON. `field` names the
 * position in error messages.
 */
export function encodeContent(value: unknown, field: string): EncodedContent {
  if (typeof value === "string") {
    return { data: encoder.encode(value), mediaType: TEXT_MEDIA_TYPE };
  }
  if (value instanceof Uint8Array) {
    return { data: value, mediaType: BYTES_MEDIA_TYPE };
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw notEncodable(field, error instanceof Error ? error.message : String(error));
  }
  if (json === undefined) {
    throw notEncodable(field, `a ${typeof value} is not a JSON value`);
  }
  return { data: encoder.encode(json), mediaType: JSON_MEDIA_TYPE };
}

// ---------------------------------------------------------------------------
// Content positions (schema 0.4).
//
// Every behaviour: model_invocation.internal_reasoning. Per behaviour: the
// fields below, plus inputs[].input_payload for Thinking and Reflecting.
// Attesting.evidence_refs may mix record ids and ContentRefs and is left as
// given.
// ---------------------------------------------------------------------------

const CONTENT_FIELDS = new Map<string, readonly string[]>([
  ["Attesting", ["effects"]],
  ["Reflecting", ["output_payload"]],
  ["Thinking", ["prompt", "output_payload"]],
  ["ToolCalling", ["input_payload", "output_payload"]],
]);

const WITH_CONTENT_INPUTS = new Set(["Reflecting", "Thinking"]);

function mapInputs(inputs: unknown[], fn: (value: unknown, field: string) => unknown): unknown[] {
  return inputs.map((entry: unknown, index) =>
    isObject(entry) && entry["input_payload"] !== undefined
      ? { ...entry, input_payload: fn(entry["input_payload"], `inputs.${index}.input_payload`) }
      : entry,
  );
}

/**
 * Rebuild `record` with `fn` applied to the value at each content position
 * that holds one. Only the containers on the way to a content position are
 * copied; `record` and everything it references stay untouched.
 */
export function mapContent(
  record: JsonObject,
  fn: (value: unknown, field: string) => unknown,
): JsonObject {
  const out: JsonObject = { ...record };
  const { behavior, inputs, model_invocation: invocation } = record;
  if (isObject(invocation) && invocation["internal_reasoning"] !== undefined) {
    out["model_invocation"] = {
      ...invocation,
      internal_reasoning: fn(
        invocation["internal_reasoning"],
        "model_invocation.internal_reasoning",
      ),
    };
  }
  const kind = typeof behavior === "string" ? behavior : "";
  for (const field of CONTENT_FIELDS.get(kind) ?? []) {
    if (record[field] !== undefined) {
      out[field] = fn(record[field], field);
    }
  }
  if (WITH_CONTENT_INPUTS.has(kind) && Array.isArray(inputs)) {
    out["inputs"] = mapInputs(inputs, fn);
  }
  return out;
}

// ---------------------------------------------------------------------------
// prepareContent / applyUploaded — the two passes around the uploads.
// ---------------------------------------------------------------------------

/** Raw content found at a content position, to upload before the record is sent. */
export interface PendingUpload {
  data: Uint8Array;
  /** The reference computed locally; the server's reference replaces it. */
  ref: ContentRef;
}

export interface PreparedRecord {
  /** The record with each raw value replaced by its locally computed ContentRef. */
  record: JsonObject;
  uploads: PendingUpload[];
}

/**
 * Replace the raw content at the content positions of `record` with the
 * ContentRef it will have once uploaded (SHA-256, size and media type,
 * computed locally) and list the uploads. The prepared record validates like
 * the final one, so nothing is uploaded for a record that would be rejected.
 * Throws ValidationError for a value that cannot be encoded.
 */
export function prepareContent(record: JsonObject): PreparedRecord {
  const uploads: PendingUpload[] = [];
  const prepared = mapContent(record, (value, field) => {
    if (isContentRef(value)) {
      return value;
    }
    const { data, mediaType } = encodeContent(value, field);
    const ref: ContentRef = {
      bytes: data.byteLength,
      media_type: mediaType,
      sha256: sha256Hex(data),
    };
    uploads.push({ data, ref });
    return ref;
  });
  return { record: prepared, uploads };
}

/** Swap the locally computed references in `record` for the ones the server returned. */
export function applyUploaded(
  record: JsonObject,
  uploaded: ReadonlyMap<unknown, ContentRef>,
): JsonObject {
  return mapContent(record, (value) => uploaded.get(value) ?? value);
}
