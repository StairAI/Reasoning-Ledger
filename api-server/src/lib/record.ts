/**
 * Shared helper used by the records, sessions, and traces route modules.
 *
 * Reconstructs a full, serialisable record object from a raw Prisma DB row.
 * Base-record columns are lifted to top-level keys; behaviour-specific fields
 * are spread in from the JSONB `payload` column.  BigInt timestamps are
 * converted to Number so the result is JSON-safe.
 */
export function reconstructRecord(row: {
  record_id: string;
  agent_id: string;
  session_id: string;
  schema_version: string;
  behavior: string;
  client_ts_utc: bigint;
  server_ts_utc: bigint;
  notes: string | null;
  tags: string[];
  model_invocation: unknown;
  upstream_record_id: string[];
  parent_record_id: string | null;
  payload: unknown;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    agent_id: row.agent_id,
    behavior: row.behavior,
    client_ts_utc: Number(row.client_ts_utc),
    record_id: row.record_id,
    schema_version: row.schema_version,
    server_ts_utc: Number(row.server_ts_utc),
    session_id: row.session_id,
    tags: row.tags,
    upstream_record_id: row.upstream_record_id,
  };
  if (row.notes) {
    base.notes = row.notes;
  }
  if (row.model_invocation) {
    base.model_invocation = row.model_invocation;
  }
  if (row.parent_record_id) {
    base.parent_record_id = row.parent_record_id;
  }
  // Merge behaviour-specific payload fields on top of base columns.
  return { ...base, ...(row.payload as Record<string, unknown>) };
}
