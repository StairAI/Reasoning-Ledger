// ---------------------------------------------------------------------------
// Schema version — bundled constant; stamped on every submitted record.
// ---------------------------------------------------------------------------

export { SCHEMA_VERSION } from "./generated/version.js";

// ---------------------------------------------------------------------------
// Size limits (§10.2) — enforced client-side before any network call.
// Values are in bytes for JSON-encoded fields, or item counts for arrays.
// Content positions (prompts, payloads, internal reasoning) hold content
// references, so their size is enforced by the server on upload (HTTP 413).
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
  /** `ToolCalling.tool_meta` JSON-encoded size (16 KB). */
  TOOL_META: 16 * 1024,
  /** `Observing.trigger_payload_summary` (4 KB). */
  TRIGGER_PAYLOAD_SUMMARY: 4096,
} as const;
