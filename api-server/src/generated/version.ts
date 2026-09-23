// Code generated from schema/records.schema.json — do not edit manually.

// The only version the server accepts on write.
export const SCHEMA_VERSION = "0.4" as const;

// Every version a stored record may carry: the current schema plus every
// snapshot under schema/history/. Older versions are readable, not writable.
export const KNOWN_SCHEMA_VERSIONS = ["0.1", "0.2", "0.3", "0.4"] as const;

// Labels once stamped on records and never reused.
export const RETIRED_SCHEMA_VERSIONS = ["1.0"] as const;
