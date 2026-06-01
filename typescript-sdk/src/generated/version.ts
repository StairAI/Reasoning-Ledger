// Code generated from schema/records.schema.json — do not edit manually.

export const SCHEMA_VERSION = "0.3" as const;

// Every version the server still accepts on the wire: the current live
// schema plus every snapshot under schema/history/. Drives server-side
// version validation; lets old SDK clients keep submitting during migrations.
export const SUPPORTED_SCHEMA_VERSIONS = ["0.1", "0.2", "0.3"] as const;
