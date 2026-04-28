import "dotenv/config";
import { createServer } from "node:http";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { CORSPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { router } from "./routes";

const handler = new OpenAPIHandler(router, {
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

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

const server = createServer(async (req, res) => {
  const result = await handler.handle(req, res, {
    context: { headers: req.headers as Record<string, string | string[] | undefined> },
  });

  if (!result.matched) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "No procedure matched" }));
  }
});

server.listen(PORT, HOST, () => console.log(`Reasoning Ledger API listening on ${HOST}:${PORT}`));
