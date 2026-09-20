/**
 * Shared helper used by the records, sessions, and traces route modules.
 *
 * Reconstructs a full, serialisable record object from a raw Prisma DB row.
 * Base-record columns are lifted to top-level keys; behaviour-specific fields
 * are spread in from the JSONB `payload` column.  BigInt timestamps and the
 * server-assigned `sequence` are converted to Number so the result is JSON-safe.
 * Columns added in schema 0.4 (executor, record_phase, outcome, duration_ms)
 * are omitted when empty, so older records read back as they were written.
 */
export function reconstructRecord(row: {
  record_id: string;
  agent_id: string;
  session_id: string;
  schema_version: string;
  behavior: string;
  client_ts_utc: bigint;
  server_ts_utc: bigint;
  sequence: bigint;
  executor: string | null;
  record_phase: string | null;
  outcome: string | null;
  duration_ms: number | null;
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
    sequence: Number(row.sequence),
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
  if (row.executor) {
    base.executor = row.executor;
  }
  if (row.record_phase) {
    base.record_phase = row.record_phase;
  }
  if (row.outcome) {
    base.outcome = row.outcome;
  }
  if (row.duration_ms !== null) {
    base.duration_ms = row.duration_ms;
  }
  // Merge behaviour-specific payload fields on top of base columns.
  return { ...base, ...(row.payload as Record<string, unknown>) };
}
