import { setTimeout as sleep } from "node:timers/promises";

import {
  AuthError,
  IdempotencyConflictError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "./errors.js";
import type { HttpRequest, HttpResponse, HttpTransport, RetryConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Default retry configuration (§7.5 / §8.3).
// ---------------------------------------------------------------------------

export const DEFAULT_RETRY: RetryConfig = {
  attempts: 3,
  backoffMs: [500, 1000, 2000],
};

// ---------------------------------------------------------------------------
// FetchTransport — default HttpTransport backed by the native fetch API.
// Sends string or binary bodies; returns the body as text and as raw bytes.
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const { cause } = error;
  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}

export class FetchTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    try {
      const res = await fetch(req.url, {
        // fetch sends any Uint8Array; TypeScript's BodyInit only admits ArrayBuffer-backed ones.
        body: req.body as string | Uint8Array<ArrayBuffer> | undefined,
        headers: req.headers,
        method: req.method,
      });
      const bodyBytes = new Uint8Array(await res.arrayBuffer());
      return {
        body: decoder.decode(bodyBytes),
        bodyBytes,
        headers: Object.fromEntries(res.headers.entries()),
        status: res.status,
      };
    } catch (error) {
      // fetch rejects only when no complete HTTP response arrived (DNS failure,
      // connection refused or reset, malformed URL). Retryable.
      throw new NetworkError(`Network error: ${describeFailure(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// parseErrorBody — attempt to extract a human-readable message from the
// server response body (oRPC wraps errors in { message: string }).
// ---------------------------------------------------------------------------

function parseErrorBody(body: string): { message: string; details?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const message =
      typeof parsed["message"] === "string" ? parsed["message"] : `Server returned error`;
    const details =
      typeof parsed["details"] === "object" && parsed["details"] !== null
        ? (parsed["details"] as Record<string, unknown>)
        : undefined;
    return { details, message };
  } catch {
    return { message: body.length > 0 ? body.slice(0, 256) : "Unknown error" };
  }
}

// ---------------------------------------------------------------------------
// mapHttpError — convert an HTTP response with a non-2xx status to the
// appropriate LedgerError subclass.
// ---------------------------------------------------------------------------

export function mapHttpError(res: HttpResponse): never {
  const { details, message } = parseErrorBody(res.body);

  switch (res.status) {
    case 400: {
      throw new ValidationError(message, details);
    }
    case 401: {
      throw new AuthError(message, details);
    }
    case 404:
    case 410: {
      // 410: the content existed but was deleted.
      throw new NotFoundError(message, details);
    }
    case 409: {
      throw new IdempotencyConflictError(message, details);
    }
    case 413: {
      throw new ValidationError(`Payload too large for the server: ${message}`, {
        ...details,
        reason: "payload too large",
        status: res.status,
      });
    }
    case 429: {
      const retryAfter =
        res.headers["retry-after"] === undefined
          ? undefined
          : { retry_after_ms: Number(res.headers["retry-after"]) * 1000 };
      throw new RateLimitError(message, { ...details, ...retryAfter });
    }
    default: {
      if (res.status >= 500) {
        throw new ServerError(message, { ...details, status: res.status });
      }
      throw new ServerError(`Unexpected HTTP status ${res.status}: ${message}`, {
        ...details,
        status: res.status,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// shouldRetry — only retry on transient errors (NetworkError + ServerError).
// ---------------------------------------------------------------------------

export function shouldRetry(err: unknown): boolean {
  return err instanceof NetworkError || err instanceof ServerError;
}

// ---------------------------------------------------------------------------
// withRetry — execute `fn`, retrying on transient errors with exponential
// backoff. Uses `config.attempts` total attempts and `config.backoffMs` for
// delays between consecutive attempts.
// ---------------------------------------------------------------------------

export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY,
): Promise<T> {
  let lastErr: Error = new Error("withRetry: exhausted all attempts");

  for (let attempt = 0; attempt < config.attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (shouldRetry(error)) {
        lastErr = error instanceof Error ? error : new Error(String(error));
        if (attempt < config.attempts - 1) {
          const delay = config.backoffMs[attempt] ?? config.backoffMs.at(-1) ?? 500;
          await sleep(delay);
        }
      } else {
        throw error;
      }
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// sendRequest — one API call: X-API-Key header, retries on transient errors,
// and a LedgerError for any non-2xx response. Bodies may be text or bytes.
// ---------------------------------------------------------------------------

export interface ApiRequest {
  apiKey: string;
  body?: string | Uint8Array;
  contentType?: string;
  method: string;
  url: string;
}

export function sendRequest(
  transport: HttpTransport,
  retry: RetryConfig,
  req: ApiRequest,
): Promise<HttpResponse> {
  const headers: Record<string, string> = { "x-api-key": req.apiKey };
  if (req.contentType !== undefined) {
    headers["content-type"] = req.contentType;
  }

  return withRetry(async () => {
    const res = await transport.request({
      body: req.body,
      headers,
      method: req.method,
      url: req.url,
    });

    if (res.status < 200 || res.status >= 300) {
      mapHttpError(res);
    }

    return res;
  }, retry);
}

// ---------------------------------------------------------------------------
// buildUrl — append query string parameters to a base URL.
// Undefined values are omitted.
// ---------------------------------------------------------------------------

export function buildUrl(
  base: string,
  params: Record<string, string | number | undefined>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      qs.set(key, String(value));
    }
  }
  const queryString = qs.toString();
  return queryString.length > 0 ? `${base}?${queryString}` : base;
}
