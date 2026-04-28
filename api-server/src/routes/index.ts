import { ownersRouter } from "./owners";
import { agentsRouter } from "./agents";
import { recordsRouter } from "./records";
import { sessionsRouter } from "./sessions";
import { tracesRouter } from "./traces";

/**
 * Root oRPC router for the Reasoning Ledger API.
 *
 * Route groups map to the three API planes defined in the design doc §9:
 *   - owners:   Control plane — owner lifecycle (website/admin tooling only)
 *   - agents:   Control plane — agent lifecycle (SDK-facing)
 *   - records:  Data plane   — record submission and retrieval
 *   - sessions: Data plane   — session record retrieval
 *   - traces:   Data plane   — paginated agent trace retrieval
 *
 * Tags are declared per-procedure via .route({ tags }) so the Scalar/Swagger
 * UI renders them in labelled, collapsible sections.
 */
export const router = {
  agents: agentsRouter,
  owners: ownersRouter,
  records: recordsRouter,
  sessions: sessionsRouter,
  traces: tracesRouter,
};
