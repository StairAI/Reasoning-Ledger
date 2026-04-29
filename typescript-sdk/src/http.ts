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
// ---------------------------------------------------------------------------

export class FetchTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const res = await fetch(req.url, {
      body: req.body,
      headers: req.headers,
      method: req.method,
    });

    // Read the body text; headers → plain object.
    const body = await res.text();
    const headers: Record<string, string> = {};
    for (const [key, value] of res.headers.entries()) {
      headers[key] = value;
    }

    return { body, headers, status: res.status };
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
    case 404: {
      throw new NotFoundError(message, details);
    }
    case 409: {
      throw new IdempotencyConflictError(message, details);
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
