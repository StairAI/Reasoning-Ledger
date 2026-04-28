import { ownersRouter } from "#/routes/owners";
import { agentsRouter } from "#/routes/agents";
import { recordsRouter } from "#/routes/records";
import { sessionsRouter } from "#/routes/sessions";
import { tracesRouter } from "#/routes/traces";

/**
 * Root oRPC router for the Reasoning Ledger API.
 *
 * Route groups map to the three API planes defined in the design doc §9:
 *   - owners:  Control plane — owner lifecycle (website/admin tooling only)
 *   - agents:  Control plane — agent lifecycle (SDK-facing)
 *   - records: Data plane — record submission and retrieval
 *   - sessions: Data plane — session record retrieval
 *   - traces:  Data plane — paginated agent trace retrieval
 */
export const router = {
  owners: ownersRouter,
  agents: agentsRouter,
  records: recordsRouter,
  sessions: sessionsRouter,
  traces: tracesRouter,
};
