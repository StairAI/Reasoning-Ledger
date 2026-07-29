import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { JsonifiedClient } from "@orpc/openapi-client";
import type { RouterClient } from "@orpc/server";
import { router } from "#/routes";
import type { Router } from "#/routes";

/**
 * Typed oRPC client over the OpenAPI transport (`/v1`).
 *
 * Responses are JSON, so timestamps/BigInts arrive as their JSON forms — the
 * `JsonifiedClient` wrapper reflects that in the types.
 *
 * Intended for server-side use (Astro frontmatter / SSR): the read endpoints it
 * calls (`traces.*`, `records.getRecord`) are public, so no API key is attached.
 * If a call to an authed endpoint is ever needed here, pass an `X-API-Key`
 * header via the `headers` option below.
 */
export type TraceClient = JsonifiedClient<RouterClient<Router>>;

export function createTraceClient(origin: string): TraceClient {
  const link = new OpenAPILink(router, {
    url: `${origin}/v1`,
  });
  return createORPCClient(link);
}
