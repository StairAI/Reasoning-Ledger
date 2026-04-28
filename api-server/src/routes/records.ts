import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { authed } from "#/lib/auth";
import { Record as LedgerRecord } from "#/generated/records";
import type { BehaviorType } from "#/generated/prisma";

// ---------------------------------------------------------------------------
// Supported schema versions (server rejects unknown versions per §10.1)
// ---------------------------------------------------------------------------

const SUPPORTED_SCHEMA_VERSIONS = new Set(["1.0"]);

// ---------------------------------------------------------------------------
// Size limits (§10.2) — per-record total enforced in bytes
// ---------------------------------------------------------------------------

const MAX_RECORD_BYTES = 64 * 1024; // 64 KB
const MAX_BATCH_BYTES = 1024 * 1024; // 1 MB
const MAX_BATCH_SIZE = 50;

// ---------------------------------------------------------------------------
// RecordAck shape
// ---------------------------------------------------------------------------

const RecordAck = z.object({
  record_id: z.string(),
  session_id: z.string(),
  server_ts_utc: z.number(),
  is_duplicate: z.boolean(),
});

const RecordError = z.object({
  record_id: z.string(),
  code: z.string(),
  message: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the behaviour-specific payload fields from a full record object.
 * Base fields are stored as dedicated columns; the rest go into `payload`.
 */
function extractPayload(record: z.infer<typeof LedgerRecord>): Record<string, unknown> {
  const {
    schema_version: _sv,
    agent_id: _ai,
    session_id: _si,
    record_id: _ri,
    behavior: _b,
    client_ts_utc: _ct,
    notes: _n,
    tags: _t,
    model_invocation: _mi,
    upstream_record_id: _up,
    parent_record_id: _pr,
    ...payload
  } = record as Record<string, unknown>;
  return payload as Record<string, unknown>;
}

/**
 * Validate that the agent exists and belongs to the calling owner.
 * Returns the agent record.
 */
async function assertAgentOwnership(agentId: string, ownerId: string) {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, owner_id: true },
  });
  if (!agent || agent.owner_id !== ownerId) {
    throw new ORPCError("UNAUTHORIZED", {
      message: `agent_id '${agentId}' does not belong to this owner`,
    });
  }
}

/**
 * Validate that each entry in upstream_record_id / parent_record_id resolves
 * to an existing record under the same agent_id (§10.1 server-side rules).
 */
async function validateRecordRefs(
  agentId: string,
  upstreamIds: string[],
  parentId: string | undefined,
) {
  const allIds = [...new Set([...upstreamIds, ...(parentId ? [parentId] : [])])];
  if (allIds.length === 0) return;

  const found = await prisma.traceRecord.findMany({
    where: { record_id: { in: allIds }, agent_id: agentId },
    select: { record_id: true },
  });
  const foundSet = new Set(found.map((r) => r.record_id));

  for (const id of upstreamIds) {
    if (!foundSet.has(id)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `upstream_record_id '${id}' does not exist under this agent`,
      });
    }
  }
  if (parentId && !foundSet.has(parentId)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `parent_record_id '${parentId}' does not exist under this agent`,
    });
  }
}

/**
 * Persist one validated record and return a RecordAck.
 * Handles deduplication: if (agent_id, record_id) already exists, return
 * the stored record with is_duplicate: true — do not create a duplicate.
 */
async function persistRecord(
  record: z.infer<typeof LedgerRecord>,
  agentId: string,
): Promise<z.infer<typeof RecordAck>> {
  const serverTs = BigInt(Date.now());

  // Dedup check on (agent_id, record_id).
  const existing = await prisma.traceRecord.findFirst({
    where: { record_id: record.record_id, agent_id: agentId },
    select: { record_id: true, session_id: true, server_ts_utc: true },
  });
  if (existing) {
    return {
      record_id: existing.record_id,
      session_id: existing.session_id,
      server_ts_utc: Number(existing.server_ts_utc),
      is_duplicate: true,
    };
  }

  const created = await prisma.traceRecord.create({
    data: {
      record_id: record.record_id,
      agent_id: agentId,
      session_id: record.session_id,
      schema_version: record.schema_version,
      behavior: record.behavior as BehaviorType,
      client_ts_utc: BigInt(record.client_ts_utc),
      server_ts_utc: serverTs,
      notes: record.notes,
      tags: record.tags ?? [],
      model_invocation: record.model_invocation ?? undefined,
      upstream_record_id: record.upstream_record_id ?? [],
      parent_record_id: record.parent_record_id,
      payload: extractPayload(record),
    },
    select: { record_id: true, session_id: true, server_ts_utc: true },
  });

  return {
    record_id: created.record_id,
    session_id: created.session_id,
    server_ts_utc: Number(created.server_ts_utc),
    is_duplicate: false,
  };
}

/**
 * Reconstruct a full record object from a DB row (columns + payload JSON).
 * BigInt timestamps are converted to numbers for JSON serialization.
 */
function reconstructRecord(row: {
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
    record_id: row.record_id,
    agent_id: row.agent_id,
    session_id: row.session_id,
    schema_version: row.schema_version,
    behavior: row.behavior,
    client_ts_utc: Number(row.client_ts_utc),
    server_ts_utc: Number(row.server_ts_utc),
    tags: row.tags,
    upstream_record_id: row.upstream_record_id,
  };
  if (row.notes) base.notes = row.notes;
  if (row.model_invocation) base.model_invocation = row.model_invocation;
  if (row.parent_record_id) base.parent_record_id = row.parent_record_id;
  // Merge behaviour-specific payload fields.
  return { ...base, ...(row.payload as Record<string, unknown>) };
}

/**
 * Full server-side validation for a single record:
 * schema_version, agent ownership, and DAG reference integrity.
 * Throws ORPCError on failure.
 */
async function validateRecord(
  record: z.infer<typeof LedgerRecord>,
  ownerId: string,
  agentId: string,
) {
  if (!SUPPORTED_SCHEMA_VERSIONS.has(record.schema_version)) {
    throw new ORPCError("BAD_REQUEST", {
      message: `Unsupported schema_version '${record.schema_version}'. Supported: ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")}`,
    });
  }

  await assertAgentOwnership(agentId, ownerId);

  await validateRecordRefs(
    agentId,
    record.upstream_record_id ?? [],
    record.parent_record_id,
  );
}

// ---------------------------------------------------------------------------
// POST /v1/records
// Submit a single record.
// ---------------------------------------------------------------------------

export const submitRecord = authed
  .route({ path: "/v1/records", method: "POST" })
  .input(LedgerRecord)
  .output(RecordAck)
  .handler(async ({ input, context }) => {
    // Per-record size check.
    const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (bytes > MAX_RECORD_BYTES) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Record exceeds 64 KB size limit (${bytes} bytes)`,
      });
    }

    await validateRecord(input, context.ownerId, input.agent_id);
    return persistRecord(input, input.agent_id);
  });

// ---------------------------------------------------------------------------
// POST /v1/records:batch
// Submit up to 50 records in one request.
// Per-record failures do NOT abort the batch — inspect results[].
// ---------------------------------------------------------------------------

export const submitBatch = authed
  .route({ path: "/v1/records:batch", method: "POST" })
  .input(
    z.object({
      records: z.array(LedgerRecord).min(1).max(MAX_BATCH_SIZE),
    }),
  )
  .output(
    z.object({
      batch_id: z.string(),
      results: z.array(z.union([RecordAck, RecordError])),
    }),
  )
  .handler(async ({ input, context }) => {
    // Batch-level size check.
    const batchBytes = Buffer.byteLength(JSON.stringify(input.records), "utf8");
    if (batchBytes > MAX_BATCH_BYTES) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Batch exceeds 1 MB size limit (${batchBytes} bytes)`,
      });
    }

    const batchId = crypto.randomUUID();
    const results: Array<z.infer<typeof RecordAck> | z.infer<typeof RecordError>> = [];

    for (const record of input.records) {
      // Per-record size check within batch.
      const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (bytes > MAX_RECORD_BYTES) {
        results.push({
          record_id: record.record_id,
          code: "validation_failed",
          message: `Record exceeds 64 KB size limit (${bytes} bytes)`,
        });
        continue;
      }

      try {
        await validateRecord(record, context.ownerId, record.agent_id);
        const ack = await persistRecord(record, record.agent_id);
        results.push(ack);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const code =
          err instanceof ORPCError
            ? err.code === "UNAUTHORIZED"
              ? "auth_invalid"
              : "validation_failed"
            : "server_5xx";
        results.push({
          record_id: record.record_id,
          code,
          message,
        });
      }
    }

    return { batch_id: batchId, results };
  });

// ---------------------------------------------------------------------------
// GET /v1/records/:id
// Fetch a single record by record_id.
// Verifies the record's agent belongs to the calling owner.
// ---------------------------------------------------------------------------

export const getRecord = authed
  .route({ path: "/v1/records/{record_id}", method: "GET" })
  .input(z.object({ record_id: z.string().uuid() }))
  .output(z.record(z.string(), z.unknown()))
  .handler(async ({ input, context }) => {
    const row = await prisma.traceRecord.findUnique({
      where: { record_id: input.record_id },
      include: { agent: { select: { owner_id: true } } },
    });

    if (!row || row.agent.owner_id !== context.ownerId) {
      throw new ORPCError("NOT_FOUND", { message: "Record not found" });
    }

    return reconstructRecord(row);
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const recordsRouter = {
  submitRecord,
  submitBatch,
  getRecord,
};
