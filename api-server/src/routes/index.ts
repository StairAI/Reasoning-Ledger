import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { CORSPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";

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
const router = {
  agents: agentsRouter,
  owners: ownersRouter,
  records: recordsRouter,
  sessions: sessionsRouter,
  traces: tracesRouter,
};

export const handler = new OpenAPIHandler(router, {
  interceptors: [onError(console.error)],
  plugins: [
    new CORSPlugin(),
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        components: {
          securitySchemes: {
            ApiKey: {
              description:
                "Owner-level API key issued at registration. Prefix: `sl_`. Pass as the `X-API-Key` request header.",
              in: "header",
              name: "X-API-Key",
              type: "apiKey",
            },
          },
        },
        info: {
          description:
            "Trace Service API for the Reasoning Ledger SDK — record submission, retrieval, and agent/owner lifecycle management.",
          title: "Reasoning Ledger API",
          version: "0.1.0",
        },
        // Default: every operation requires an API key.
        // Individual public endpoints override this with `spec: { security: [] }`.
        security: [{ ApiKey: [] }],
        tags: [
          {
            description:
              "Owner lifecycle — registration, metadata updates, and API key rotation. " +
              "These endpoints are called by the Stair AI website / admin tooling, not by the SDK.",
            name: "Owners",
          },
          {
            description:
              "Agent lifecycle — registration, name resolution, metadata retrieval and updates. " +
              "These are the primary SDK-facing control-plane endpoints.",
            name: "Agents",
          },
          {
            description:
              "Data plane — submit individual records or batches, and retrieve records by ID. " +
              "Submission is idempotent on `(agent_id, record_id)`.",
            name: "Records",
          },
          {
            description:
              "Data plane — retrieve all records belonging to a session. " +
              "Sessions have no server-side lifecycle; this is a filtered view of the agent's trace.",
            name: "Sessions",
          },
          {
            description:
              "Data plane — paginated read of an agent's full append-only reasoning trace, newest first.",
            name: "Traces",
          },
        ],
      },
    }),
  ],
});
