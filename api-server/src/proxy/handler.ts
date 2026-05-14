import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticateProxyRequest } from "./auth";
import { forwardRequest } from "./client";
import { logUsage } from "./usage";

export async function handleProxyRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Parse URL: /proxy/{service}/{...rest}
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathParts = url.pathname.split("/").filter(Boolean);

    if (pathParts[0] !== "proxy" || pathParts.length < 2) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Invalid proxy path" }));
      return;
    }

    const service = pathParts[1] as "sportmonks" | "polymarket";
    if (!["sportmonks", "polymarket"].includes(service)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Unknown proxy service" }));
      return;
    }

    // Authenticate
    const authCtx = await authenticateProxyRequest(req, service);

    // Extract upstream path (everything after /proxy/{service})
    const upstreamPath = `/${pathParts.slice(2).join("/")}${url.search}`;

    // Read request body (for POST/PUT/PATCH)
    let body: Buffer | undefined;
    if (["POST", "PUT", "PATCH"].includes(req.method || "")) {
      body = await readBody(req);
    }

    // Forward request
    const proxyRes = await forwardRequest(
      req.method || "GET",
      upstreamPath,
      service,
      authCtx.upstreamKey,
      req.headers,
      body,
      res,
    );

    // Log usage (fire and forget - don't block response)
    void logUsage({
      latencyMs: proxyRes.latencyMs,
      method: req.method || "GET",
      path: upstreamPath,
      proxyKeyId: authCtx.proxyKeyId,
      responseBytes: proxyRes.bodyBytes,
      service,
      statusCode: proxyRes.statusCode,
    });
  } catch (error) {
    // Handle errors
    const message = error instanceof Error ? error.message : String(error);

    if (message.startsWith("UNAUTHORIZED")) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: message }));
    } else if (message.startsWith("QUOTA_EXCEEDED")) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: message }));
    } else if (message.startsWith("UPSTREAM_ERROR")) {
      res.statusCode = 502;
      res.end(JSON.stringify({ details: message, error: "Bad Gateway" }));
    } else {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "Internal Server Error" }));
      console.error("Proxy error:", error);
    }
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  // eslint-disable-next-line promise/avoid-new
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
