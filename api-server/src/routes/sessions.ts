import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { authed } from "#/lib/auth";
import { reconstructRecord } from "#/lib/record";

// ---------------------------------------------------------------------------
// GET /v1/sessions/:session_id?agent_id=...
// Fetch all records in a session, ordered by server_ts_utc ascending.
// ---------------------------------------------------------------------------

export const getSession = authed
  .route({
    description:
      "Fetch every record submitted under a given `(agent_id, session_id)` pair, ordered by `server_ts_utc` ascending. " +
      "Sessions have no server-side lifecycle — this is a filtered view of the agent's trace. " +
      "Returns an empty `records` array when the session exists but contains no records.",
    method: "GET",
    path: "/v1/sessions/{session_id}",
    summary: "Get session records",
    tags: ["Sessions"],
  })
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
