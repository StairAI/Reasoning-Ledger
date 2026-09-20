import { ORPCError } from "@orpc/server";
import {
  KNOWN_SCHEMA_VERSIONS,
  RETIRED_SCHEMA_VERSIONS,
  SCHEMA_VERSION,
} from "#/generated/version";

const known = new Set<string>(KNOWN_SCHEMA_VERSIONS);
const retired = new Set<string>(RETIRED_SCHEMA_VERSIONS);

/**
 * Why a record with this schema_version cannot be written, or undefined when it can.
 * Only the current schema is writable; records stamped with older versions stay readable.
 */
export function writeVersionProblem(version: unknown): string | undefined {
  if (version === SCHEMA_VERSION) {
    return undefined;
  }
  if (typeof version !== "string" || version.length === 0) {
    return `schema_version is required; this server accepts ${SCHEMA_VERSION}`;
  }
  if (retired.has(version)) {
    return `schema_version '${version}' comes from an SDK release that is no longer supported; upgrade to an SDK that writes ${SCHEMA_VERSION}`;
  }
  if (known.has(version)) {
    return `schema_version '${version}' is readable but no longer accepted for writes; upgrade to an SDK that writes ${SCHEMA_VERSION}`;
  }
  return `Unsupported schema_version '${version}'; this server accepts ${SCHEMA_VERSION}`;
}

/** Throws BAD_REQUEST when the version is not writable. */
export function assertWritableVersion(version: unknown): void {
  const problem = writeVersionProblem(version);
  if (problem) {
    throw new ORPCError("BAD_REQUEST", { message: problem });
  }
}

function schemaVersionOf(value: unknown): unknown {
  return typeof value === "object" && value !== null
    ? (value as { schema_version?: unknown }).schema_version
    : undefined;
}

/** Version check on a raw single-record body, before schema validation. */
export function assertWritableRecord(raw: unknown): void {
  assertWritableVersion(schemaVersionOf(raw));
}

/** Version check on a raw batch body, before schema validation. */
export function assertWritableBatch(raw: unknown): void {
  const records =
    typeof raw === "object" && raw !== null ? (raw as { records?: unknown }).records : undefined;
  if (!Array.isArray(records)) {
    return;
  }
  for (const record of records) {
    assertWritableVersion(schemaVersionOf(record));
  }
}
