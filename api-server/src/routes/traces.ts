import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { authed } from "#/lib/auth";

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
// GET /v1/traces/:agent_id
// Paginated read of an agent's full trace, ordered by server_ts_utc DESC.
//
// Pagination: cursor-based using `before` (a record_id). The server looks up
// the server_ts_utc of the cursor record and returns all records older than
// that timestamp. This gives stable pages even when new records are appended.
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const getTrace = authed
  .route({ method: "GET", path: "/v1/traces/{agent_id}" })
  .input(
    z.object({
      agent_id: z.string().uuid(),
      before: z.string().uuid().optional(), // record_id cursor
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    }),
  )
  .output(
    z.object({
      next_cursor: z.string().nullable(),
      records: z.array(z.record(z.string(), z.unknown())),
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

    // Resolve cursor → server_ts_utc threshold.
    let cursorTs: bigint | undefined;
    if (input.before) {
      const cursor = await prisma.traceRecord.findUnique({
        select: { agent_id: true, server_ts_utc: true },
        where: { record_id: input.before },
      });
      if (!cursor || cursor.agent_id !== input.agent_id) {
        throw new ORPCError("BAD_REQUEST", {
          message: `Cursor record_id '${input.before}' not found for this agent`,
        });
      }
      cursorTs = cursor.server_ts_utc;
    }

    // Fetch limit+1 rows so we can detect whether there's a next page.
    const rows = await prisma.traceRecord.findMany({
      orderBy: { server_ts_utc: "desc" },
      take: input.limit + 1,
      where: {
        agent_id: input.agent_id,
        ...(cursorTs !== undefined && { server_ts_utc: { lt: cursorTs } }),
      },
    });

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const nextCursor = hasMore ? (page.at(-1)?.record_id ?? null) : null;

    return {
      next_cursor: nextCursor,
      records: page.map(reconstructRecord),
    };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const tracesRouter = {
  getTrace,
};
