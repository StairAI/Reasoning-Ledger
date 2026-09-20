/**
 * Owner-scoped reads (design §4.2). Every read path — the /v1 API and the
 * visualiser pages — goes through these functions, so "only this owner's data"
 * is enforced in one place. Anything outside the owner's namespace looks the
 * same as something that does not exist; callers answer 404.
 */

import { prisma } from "#/lib/prisma";

export function ownedAgent(ownerId: string, agentId: string) {
  return prisma.agent.findFirst({
    select: { id: true, name: true },
    where: { id: agentId, owner_id: ownerId },
  });
}

export function ownedRecord(ownerId: string, recordId: string) {
  return prisma.traceRecord.findFirst({
    where: { agent: { owner_id: ownerId }, record_id: recordId },
  });
}

/**
 * One page of an agent's trace, newest first. `before` is the cursor returned
 * with the previous page: the record `sequence` to continue below.
 */
export async function ownedTracePage(
  ownerId: string,
  agentId: string,
  opts: { before?: bigint; limit: number },
) {
  if (!(await ownedAgent(ownerId, agentId))) {
    return;
  }
  const rows = await prisma.traceRecord.findMany({
    orderBy: { sequence: "desc" },
    take: opts.limit + 1,
    where: {
      agent_id: agentId,
      ...(opts.before !== undefined && { sequence: { lt: opts.before } }),
    },
  });
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page.at(-1);
  return { nextCursor: hasMore && last ? String(last.sequence) : null, rows: page };
}

/** Every record of one (agent, session), in the order the server received them. */
export async function ownedSession(ownerId: string, agentId: string, sessionId: string) {
  const agent = await ownedAgent(ownerId, agentId);
  if (!agent) {
    return;
  }
  const rows = await prisma.traceRecord.findMany({
    orderBy: { sequence: "asc" },
    where: { agent_id: agentId, session_id: sessionId },
  });
  return { agent, rows };
}

export interface SessionSummary {
  agent_id: string;
  agent_name: string;
  behaviors: string[];
  first_ts: number;
  last_ts: number;
  llm_calls: number;
  record_count: number;
  session_id: string;
  tokens: number;
}

/** The owner's sessions with aggregate stats, most recently active first. */
export async function ownedSessionSummaries(
  ownerId: string,
  limit: number,
): Promise<SessionSummary[]> {
  // Token totals live inside the model_invocation JSONB, so a raw query is the
  // cleanest way to sum them.
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
    WHERE a.owner_id = ${ownerId}
    GROUP BY tr.agent_id, a.name, tr.session_id
    ORDER BY max(tr.sequence) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    agent_id: r.agent_id,
    agent_name: r.agent_name,
    behaviors: r.behaviors,
    first_ts: Number(r.first_ts),
    last_ts: Number(r.last_ts),
    llm_calls: Number(r.llm_calls),
    record_count: Number(r.record_count),
    session_id: r.session_id,
    tokens: Number(r.tokens),
  }));
}

/** Aggregate stats over a session's records. */
export function sessionStats(rows: { behavior: string; model_invocation: unknown }[]) {
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
  return { behaviors: [...behaviors], llm_calls: llmCalls, record_count: rows.length, tokens };
}
