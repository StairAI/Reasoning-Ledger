import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { authed } from "#/lib/auth";
import { reconstructRecord } from "#/lib/record";
import { ownedSessionSummaries, ownedTracePage } from "#/lib/repository";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// GET /v1/traces/:agent_id
// Paginated read of one of the caller's agents, newest first.
//
// Cursor pagination on `sequence`, the server-assigned total order: pass the
// previous page's `next_cursor` as `before`. Pages stay stable while new
// records are appended.
// ---------------------------------------------------------------------------

export const getTrace = authed
  .route({
    description:
      "Paginated read of one of your agents' traces, newest first (by the server-assigned `sequence`). " +
      "Pass the `next_cursor` from a previous response as `before` to fetch the next page; `next_cursor` is `null` on the last page. " +
      "`limit` defaults to 100 and is capped at 500. " +
      "An agent that is not yours answers 404, the same as one that does not exist.",
    method: "GET",
    path: "/traces/{agent_id}",
    summary: "Get agent trace",
    tags: ["Traces"],
  })
  .input(
    z.object({
      agent_id: z.string().uuid(),
      before: z
        .string()
        .regex(/^\d+$/, "before must be a next_cursor from a previous page")
        .optional(),
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
    const page = await ownedTracePage(context.ownerId, input.agent_id, {
      before: input.before === undefined ? undefined : BigInt(input.before),
      limit: input.limit,
    });
    if (!page) {
      throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
    }
    return { next_cursor: page.nextCursor, records: page.rows.map(reconstructRecord) };
  });

// ---------------------------------------------------------------------------
// GET /v1/traces
// The caller's reasoning traces (one per agent + session) with aggregate
// stats, most recently active first.
// ---------------------------------------------------------------------------

const SessionSummary = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  behaviors: z.array(z.string()),
  first_ts: z.number(),
  last_ts: z.number(),
  llm_calls: z.number(),
  record_count: z.number(),
  session_id: z.string(),
  tokens: z.number(),
});

export const listSessions = authed
  .route({
    description:
      "List your reasoning traces grouped by agent and `session_id`, most recently active first, with aggregate stats " +
      "(record count, LLM calls, total tokens, distinct behaviours, first/last timestamps). Only your own agents are listed.",
    method: "GET",
    path: "/traces",
    summary: "List traces (sessions)",
    tags: ["Traces"],
  })
  .input(
    z.object({
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    }),
  )
  .output(z.object({ sessions: z.array(SessionSummary) }))
  .handler(async ({ input, context }) => ({
    sessions: await ownedSessionSummaries(context.ownerId, input.limit),
  }));

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const tracesRouter = {
  getTrace,
  listSessions,
};
