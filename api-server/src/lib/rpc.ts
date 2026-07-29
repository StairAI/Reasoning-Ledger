import { createRouterClient } from "@orpc/server";
import type { RouterClient } from "@orpc/server";
import { router } from "#/routes";
import type { Router } from "#/routes";

/**
 * Typed oRPC client for server-side (SSR) data fetching.
 *
 * This is an IN-PROCESS client (`createRouterClient`): it invokes the router's
 * handlers directly, with no HTTP round-trip. That deliberately avoids a
 * server-to-self fetch — behind a reverse proxy (e.g. Coolify) the request's
 * public origin round-trips out through the proxy and returns a non-JSON error
 * page ("Cannot parse response body"), and a hardcoded loopback IP is fragile
 * because dev and prod bind different interfaces (localhost/::1 vs 0.0.0.0).
 *
 * The public HTTP API at `/v1` (OpenAPIHandler) is unchanged and still serves
 * external SDK consumers; this is purely how our own pages read data.
 *
 * Only the public read endpoints (`traces.*`, `records.getRecord`) are used
 * here, so an empty `headers` context is sufficient. Calling an authed
 * procedure through this client would hit the auth middleware and require a
 * real `X-API-Key` in the context headers.
 */
export type TraceClient = RouterClient<Router>;

export function createTraceClient(): TraceClient {
  return createRouterClient(router, {
    context: { headers: {} },
  });
}
