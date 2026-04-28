import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { authed } from "#/lib/auth";
import { reconstructRecord } from "#/lib/record";
import { Record as LedgerRecord } from "#/generated/records";
import type { BehaviorType } from "#/generated/prisma/enums";

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
  is_duplicate: z.boolean(),
  record_id: z.string(),
  server_ts_utc: z.number(),
  session_id: z.string(),
});

const RecordError = z.object({
  code: z.string(),
  message: z.string(),
  record_id: z.string(),
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
    select: { id: true, owner_id: true },
    where: { id: agentId },
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
  if (allIds.length === 0) {
    return;
  }

  const found = await prisma.traceRecord.findMany({
    select: { record_id: true },
    where: { agent_id: agentId, record_id: { in: allIds } },
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
    select: { record_id: true, server_ts_utc: true, session_id: true },
    where: { agent_id: agentId, record_id: record.record_id },
  });
  if (existing) {
    return {
      is_duplicate: true,
      record_id: existing.record_id,
      server_ts_utc: Number(existing.server_ts_utc),
      session_id: existing.session_id,
    };
  }

  const created = await prisma.traceRecord.create({
    data: {
      agent_id: agentId,
      behavior: record.behavior as BehaviorType,
      client_ts_utc: BigInt(record.client_ts_utc),
      model_invocation: (record.model_invocation as object) ?? null,
      notes: record.notes,
      parent_record_id: record.parent_record_id,
      payload: extractPayload(record) as object,
      record_id: record.record_id,
      schema_version: record.schema_version,
      server_ts_utc: serverTs,
      session_id: record.session_id,
      tags: record.tags ?? [],
      upstream_record_id: record.upstream_record_id ?? [],
    },
    select: { record_id: true, server_ts_utc: true, session_id: true },
  });

  return {
    is_duplicate: false,
    record_id: created.record_id,
    server_ts_utc: Number(created.server_ts_utc),
    session_id: created.session_id,
  };
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

  await validateRecordRefs(agentId, record.upstream_record_id ?? [], record.parent_record_id);
}

// ---------------------------------------------------------------------------
// POST /v1/records
// Submit a single record.
// ---------------------------------------------------------------------------

export const submitRecord = authed
  .route({
    description:
      "Submit a single reasoning record. " +
      "The server validates `schema_version`, verifies that `agent_id` belongs to the calling owner, " +
      "checks that any `upstream_record_id` and `parent_record_id` references resolve to existing records under the same agent, " +
      "stamps `server_ts_utc` on receipt, and persists the record. " +
      "Submission is idempotent on `(agent_id, record_id)`: a duplicate returns the original ack with `is_duplicate: true` without creating a second row.",
    method: "POST",
    path: "/v1/records",
    summary: "Submit record",
    tags: ["Records"],
  })
  .input(LedgerRecord)
  .output(RecordAck)
  .handler(async ({ input, context }) => {
    // Per-record size check.
    const bytes = Buffer.byteLength(JSON.stringify(input), "utf-8");
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
  .route({
    description:
      "Submit up to 50 reasoning records in a single request. " +
      "Per-record failures are isolated: one invalid or conflicting record does not abort the rest. " +
      "Inspect `results[]` — each entry is either a `RecordAck` (success) or a `RecordError` (failure), in the same order as the submitted batch. " +
      "Batch-level failures (auth error, batch too large, total payload > 1 MB) raise immediately and no records are persisted.",
    method: "POST",
    path: "/v1/records:batch",
    summary: "Submit batch of records",
    tags: ["Records"],
  })
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
    const batchBytes = Buffer.byteLength(JSON.stringify(input.records), "utf-8");
    if (batchBytes > MAX_BATCH_BYTES) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Batch exceeds 1 MB size limit (${batchBytes} bytes)`,
      });
    }

    const batchId = crypto.randomUUID();
    const results: (z.infer<typeof RecordAck> | z.infer<typeof RecordError>)[] = [];

    for (const record of input.records) {
      // Per-record size check within batch.
      const bytes = Buffer.byteLength(JSON.stringify(record), "utf-8");
      if (bytes > MAX_RECORD_BYTES) {
        results.push({
          code: "validation_failed",
          message: `Record exceeds 64 KB size limit (${bytes} bytes)`,
          record_id: record.record_id,
        });
        continue;
      }

      try {
        await validateRecord(record, context.ownerId, record.agent_id);
        const ack = await persistRecord(record, record.agent_id);
        results.push(ack);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const code =
          error instanceof ORPCError
            ? error.code === "UNAUTHORIZED"
              ? "auth_invalid"
              : "validation_failed"
            : "server_5xx";
        results.push({
          code,
          message,
          record_id: record.record_id,
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
  .route({
    description:
      "Fetch a single reasoning record by `record_id`. " +
      "The record's agent must belong to the calling owner — records belonging to other owners return 404.",
    method: "GET",
    path: "/v1/records/{record_id}",
    summary: "Get record",
    tags: ["Records"],
  })
  .input(z.object({ record_id: z.string().uuid() }))
  .output(z.record(z.string(), z.unknown()))
  .handler(async ({ input, context }) => {
    const row = await prisma.traceRecord.findUnique({
      include: { agent: { select: { owner_id: true } } },
      where: { record_id: input.record_id },
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
  getRecord,
  submitBatch,
  submitRecord,
};
