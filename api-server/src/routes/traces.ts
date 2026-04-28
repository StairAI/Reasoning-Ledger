import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { authed } from "#/lib/auth";
import { reconstructRecord } from "#/lib/record";

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
  .route({
    description:
      "Paginated read of an agent's full trace, ordered by `server_ts_utc` descending (newest first). " +
      "Uses cursor-based pagination: pass the `next_cursor` from a previous response as the `before` parameter to fetch the next page. " +
      "`limit` defaults to 100 and is capped at 500. " +
      "`next_cursor` is `null` when there are no more pages.",
    method: "GET",
    path: "/v1/traces/{agent_id}",
    summary: "Get agent trace",
    tags: ["Traces"],
  })
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
