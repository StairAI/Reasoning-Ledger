import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { authed } from "#/lib/auth";

// Re-export reconstructRecord from records to avoid duplication.
// We inline the same logic here to keep the module self-contained.
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
  return { ...base, ...(row.payload as Record<string, unknown>) };
}

// ---------------------------------------------------------------------------
// GET /v1/sessions/:session_id?agent_id=...
// Fetch all records in a session, ordered by server_ts_utc ascending.
// ---------------------------------------------------------------------------

export const getSession = authed
  .route({ method: "GET", path: "/v1/sessions/{session_id}" })
  .input(
    z.object({
      agent_id: z.string().uuid(),
      session_id: z.string().min(1),
    }),
  )
  .output(
    z.object({
      records: z.array(z.record(z.string(), z.unknown())),
      session_id: z.string(),
    }),
  )
  .handler(async ({ input, context }) => {
    // Verify the agent belongs to the calling owner.
    const agent = await prisma.agent.findUnique({
      select: { owner_id: true },
      where: { id: input.agent_id },
    });
    if (!agent || agent.owner_id !== context.ownerId) {
      throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
    }

    const rows = await prisma.traceRecord.findMany({
      orderBy: { server_ts_utc: "asc" },
      where: { agent_id: input.agent_id, session_id: input.session_id },
    });

    return {
      records: rows.map(reconstructRecord),
      session_id: input.session_id,
    };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const sessionsRouter = {
  getSession,
};
