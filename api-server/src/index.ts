import "dotenv/config";
import { createServer } from "node:http";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { CORSPlugin } from "@orpc/server/plugins";
import { onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { router } from "./router";

const handler = new OpenAPIHandler(router, {
  interceptors: [onError(console.error)],
  plugins: [
    new CORSPlugin(),
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          description:
            "Trace Service API for the Reasoning Ledger SDK — record submission, retrieval, and agent/owner lifecycle management.",
          title: "Reasoning Ledger API",
          version: "0.1.0",
        },
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
