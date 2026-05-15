// ---------------------------------------------------------------------------
// Schema version — bundled constant; stamped on every submitted record.
// ---------------------------------------------------------------------------

export { SCHEMA_VERSION } from "./generated/version.js";

// ---------------------------------------------------------------------------
// Base URLs per environment.
// ---------------------------------------------------------------------------

export const ENDPOINTS = {
  development: "http://localhost:3000",
  production: "https://api.stairai.com",
  staging: "https://staging.api.stairai.com",
} as const;

// ---------------------------------------------------------------------------
// Size limits (§10.2) — enforced client-side before any network call.
// Values are in bytes for JSON-encoded fields, or item counts for arrays.
// ---------------------------------------------------------------------------

export const SIZE_LIMITS = {
  /** `Acting.parameters` JSON-encoded size (16 KB). */
  ACTING_PARAMETERS: 16 * 1024,
  /** Per-batch total JSON-encoded size (1 MB). */
  BATCH_JSON: 1024 * 1024,
  /** `notes` field on BaseRecord (2 KB). */
  NOTES: 2048,
  /** `Other.data` JSON-encoded size (16 KB). */
  OTHER_DATA: 16 * 1024,
  /** Per-record total JSON-encoded size (64 KB). */
  RECORD_JSON: 64 * 1024,
  /** Maximum number of tags on a record (32 items). */
  TAGS_COUNT: 32,
  /** Each individual tag string (64 chars). */
  TAG_LENGTH: 64,
  /** `Thinking.output_payload` (32 KB). */
  THINKING_OUTPUT: 32 * 1024,
  /** `Thinking.prompt` (16 KB). */
  THINKING_PROMPT: 16 * 1024,
  /** `ToolCalling.input_payload` JSON-encoded size (16 KB). */
  TOOL_INPUT: 16 * 1024,
  /** `ToolCalling.tool_meta` JSON-encoded size (16 KB). */
  TOOL_META: 16 * 1024,
  /** `ToolCalling.output_payload` JSON-encoded size (32 KB). */
  TOOL_OUTPUT: 32 * 1024,
  /** `Observing.trigger_payload_summary` (4 KB). */
  TRIGGER_PAYLOAD_SUMMARY: 4096,
} as const;
