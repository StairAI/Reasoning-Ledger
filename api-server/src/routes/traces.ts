import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { base } from "#/lib/auth";
import { reconstructRecord } from "#/lib/record";

// ---------------------------------------------------------------------------
// Public-read helper: mark an operation as requiring no API key, while keeping
// the auto-generated OpenAPI operation (summary, tags, requestBody, …). The
// object form of `spec` REPLACES the whole operation, so use the function form.
// ---------------------------------------------------------------------------
const publicSpec = (current: Record<string, unknown>) => ({ ...current, security: [] });

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// ---------------------------------------------------------------------------
// GET /v1/traces/:agent_id
// Paginated read of an agent's full trace, ordered by server_ts_utc DESC.
//
// Public read (frontend visualiser). Cursor-based pagination via `before`
// (a record_id): the server resolves the cursor's server_ts_utc and returns
// records older than it, giving stable pages as new records are appended.
// ---------------------------------------------------------------------------

export const getTrace = base
  .route({
    description:
      "Paginated read of an agent's full trace, ordered by `server_ts_utc` descending (newest first). " +
      "Uses cursor-based pagination: pass the `next_cursor` from a previous response as the `before` parameter to fetch the next page. " +
      "`limit` defaults to 100 and is capped at 500. " +
      "`next_cursor` is `null` when there are no more pages. Public read — no API key required.",
    method: "GET",
    path: "/traces/{agent_id}",
    spec: publicSpec,
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
  .handler(async ({ input }) => {
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
// GET /v1/traces
// List reasoning traces (one per session) with aggregate stats, newest first.
// Powers the trace-listing page. Public read.
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

export const listSessions = base
  .route({
    description:
      "List reasoning traces grouped by `session_id`, newest first, with aggregate stats " +
      "(record count, LLM calls, total tokens, distinct behaviours, first/last timestamps). " +
      "Powers the trace-listing view. Public read — no API key required.",
    method: "GET",
    path: "/traces",
    spec: publicSpec,
    summary: "List traces (sessions)",
    tags: ["Traces"],
  })
  .input(
    z.object({
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    }),
  )
  .output(z.object({ sessions: z.array(SessionSummary) }))
  .handler(async ({ input }) => {
    // Aggregate per (agent_id, session_id). Token totals live inside the
    // model_invocation JSONB, so a raw query is the cleanest way to sum them.
    const rows = await prisma.$queryRaw<
      {
        agent_id: string;
        agent_name: string;
        session_id: string;
        record_count: bigint;
        llm_calls: bigint;
        tokens: bigint;
        behaviors: string[];
        first_ts: bigint;
        last_ts: bigint;
      }[]
    >`
      SELECT
        tr.agent_id,
        a.name AS agent_name,
        tr.session_id,
        count(*) AS record_count,
        count(*) FILTER (WHERE tr.model_invocation IS NOT NULL) AS llm_calls,
        COALESCE(SUM(
          COALESCE((tr.model_invocation->>'tokens_in')::bigint, 0) +
          COALESCE((tr.model_invocation->>'tokens_out')::bigint, 0)
        ), 0) AS tokens,
        array_agg(DISTINCT tr.behavior::text) AS behaviors,
        min(tr.client_ts_utc) AS first_ts,
        max(tr.server_ts_utc) AS last_ts
      FROM trace_records tr
      JOIN agents a ON a.id = tr.agent_id
      GROUP BY tr.agent_id, a.name, tr.session_id
      ORDER BY max(tr.server_ts_utc) DESC
      LIMIT ${input.limit}
    `;

    return {
      sessions: rows.map((r) => ({
        agent_id: r.agent_id,
        agent_name: r.agent_name,
        behaviors: r.behaviors,
        first_ts: Number(r.first_ts),
        last_ts: Number(r.last_ts),
        llm_calls: Number(r.llm_calls),
        record_count: Number(r.record_count),
        session_id: r.session_id,
        tokens: Number(r.tokens),
      })),
    };
  });

// ---------------------------------------------------------------------------
// GET /v1/traces/:agent_id/session/:session_id
// Full detail for a single reasoning trace, keyed by (agent_id, session_id).
//
// `session_id` is an arbitrary SDK-supplied group key with NO cross-agent
// uniqueness (schema: "records simply share the string"), so it MUST be scoped
// by agent — two agents can legitimately reuse the same session_id string.
// Returns every record with its reconstructed payload, the owning agent, and
// aggregate stats. Powers the trace-detail digraph. Public read.
// ---------------------------------------------------------------------------

export const getSession = base
  .route({
    description:
      "Fetch every record belonging to a single trace, keyed by `agent_id` + `session_id`, in " +
      "chronological order, with each record's behaviour-specific payload reconstructed, plus the " +
      "owning agent and aggregate stats. `session_id` is scoped per agent (it is not globally " +
      "unique). Powers the trace-detail digraph. Public read — no API key required.",
    method: "GET",
    path: "/traces/{agent_id}/session/{session_id}",
    spec: publicSpec,
    summary: "Get trace by agent + session",
    tags: ["Traces"],
  })
  .input(z.object({ agent_id: z.string().uuid(), session_id: z.string().min(1) }))
  .output(
    z.object({
      agent_id: z.string(),
      agent_name: z.string(),
      records: z.array(z.record(z.string(), z.unknown())),
      session_id: z.string(),
      stats: z.object({
        behaviors: z.array(z.string()),
        llm_calls: z.number(),
        record_count: z.number(),
        tokens: z.number(),
      }),
    }),
  )
  .handler(async ({ input }) => {
    const rows = await prisma.traceRecord.findMany({
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { client_ts_utc: "asc" },
      where: { agent_id: input.agent_id, session_id: input.session_id },
    });

    if (rows.length === 0) {
      throw new ORPCError("NOT_FOUND", { message: "Trace (session) not found" });
    }

    const { agent } = rows[0];
    let tokens = 0;
    let llmCalls = 0;
    const behaviors = new Set<string>();
    for (const row of rows) {
      behaviors.add(row.behavior);
      const mi = row.model_invocation as { tokens_in?: number; tokens_out?: number } | null;
      if (mi) {
        llmCalls += 1;
        tokens += (mi.tokens_in ?? 0) + (mi.tokens_out ?? 0);
      }
    }

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      records: rows.map(reconstructRecord),
      session_id: input.session_id,
      stats: {
        behaviors: [...behaviors],
        llm_calls: llmCalls,
        record_count: rows.length,
        tokens,
      },
    };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const tracesRouter = {
  getSession,
  getTrace,
  listSessions,
};
