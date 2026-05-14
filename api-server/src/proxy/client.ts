import { request } from "undici";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { getServiceConfig } from "./services";

export interface ProxyResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  bodyBytes: number;
  latencyMs: number;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isHopByHopHeader(header: string): boolean {
  return HOP_BY_HOP_HEADERS.has(header.toLowerCase());
}

export async function forwardRequest(
  method: string,
  path: string,
  service: "sportmonks" | "polymarket",
  upstreamApiKey: string,
  headers: IncomingHttpHeaders,
  body: Buffer | undefined,
  res: ServerResponse,
): Promise<ProxyResponse> {
  const startTime = Date.now();
  const config = getServiceConfig(service);

  // Build upstream URL
  const upstreamUrl = new URL(path, config.baseUrl);

  // Inject upstream API key based on service auth method
  if (config.authMethod === "query" && config.authKeyName) {
    upstreamUrl.searchParams.set(config.authKeyName, upstreamApiKey);
  }

  // Prepare headers (strip hop-by-hop headers)
  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!isHopByHopHeader(key) && typeof value === "string") {
      forwardHeaders[key] = value;
    }
  }

  // Inject bearer token if needed
  if (config.authMethod === "bearer") {
    forwardHeaders["Authorization"] = `Bearer ${upstreamApiKey}`;
  }

  try {
    // Make request to upstream
    const {
      statusCode,
      headers: resHeaders,
      body: resBody,
    } = await request(upstreamUrl.toString(), {
      body,
      bodyTimeout: 60_000,
      headers: forwardHeaders,
      headersTimeout: 30_000,
      method,
    });

    // Copy response headers (filter hop-by-hop)
    for (const [key, value] of Object.entries(resHeaders)) {
      if (!isHopByHopHeader(key)) {
        res.setHeader(key, value);
      }
    }

    res.statusCode = statusCode;

    let bodyBytes = 0;

    // Stream body chunks
    for await (const chunk of resBody) {
      bodyBytes += chunk.length;
      res.write(chunk);
    }

    res.end();

    return {
      bodyBytes,
      headers: resHeaders as Record<string, string | string[]>,
      latencyMs: Date.now() - startTime,
      statusCode,
    };
  } catch (error) {
    // Network error, timeout, etc.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`UPSTREAM_ERROR: ${message}`, { cause: error });
  }
}
