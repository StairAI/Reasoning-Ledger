import { ORPCError } from "@orpc/server";

interface FailedRequest {
  method: string;
  url: URL;
}

/**
 * The API handler's error interceptor (`onError(logApiError)`): one line per
 * failed call with status, error code, method and path.
 *
 * Never the request itself. Its headers carry the caller's API key or the
 * administrator's token, and a log file is the wrong place for either: the
 * database keeps only a hash of each key so that reading the server's files
 * does not hand out working credentials.
 *
 * A client error (4xx) is ordinary traffic and gets one line. Anything else is a
 * fault in the server and keeps its stack, from the underlying cause when oRPC
 * has wrapped it.
 */
export function logApiError(error: unknown, { request }: { request: FailedRequest }): void {
  const where = `${request.method} ${request.url.pathname}`;
  if (error instanceof ORPCError && error.status < 500) {
    console.warn(`api ${error.status} ${error.code} ${where}: ${error.message}`);
    return;
  }
  const status = error instanceof ORPCError ? error.status : 500;
  const fault = error instanceof ORPCError && error.cause instanceof Error ? error.cause : error;
  const detail = fault instanceof Error ? (fault.stack ?? fault.message) : String(fault);
  console.error(`api ${status} ${where}\n${detail}`);
}
