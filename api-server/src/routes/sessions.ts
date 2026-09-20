import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { authed } from "#/lib/auth";
import { reconstructRecord } from "#/lib/record";
import { ownedSession } from "#/lib/repository";

// ---------------------------------------------------------------------------
// GET /v1/sessions/:session_id?agent_id=...
// Fetch all records in a session, in the order the server received them.
// ---------------------------------------------------------------------------

export const getSession = authed
  .route({
    description:
      "Fetch every record submitted under a given `(agent_id, session_id)` pair, in the order the server received them (`sequence` ascending). " +
      "Sessions have no server-side lifecycle — this is a filtered view of the agent's trace. `session_id` is scoped per agent. " +
      "An agent that is not yours answers 404, the same as one that does not exist. " +
      "Returns an empty `records` array when the session exists but contains no records.",
    method: "GET",
    path: "/sessions/{session_id}",
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
    const session = await ownedSession(context.ownerId, input.agent_id, input.session_id);
    if (!session) {
      throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
    }
    return {
      records: session.rows.map(reconstructRecord),
      session_id: input.session_id,
    };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const sessionsRouter = {
  getSession,
};
