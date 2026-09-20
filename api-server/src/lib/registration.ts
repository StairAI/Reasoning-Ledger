/**
 * Who may register owners (design §4.1).
 *
 *   RL_REGISTRATION=admin (default)  only requests carrying X-Admin-Token equal to
 *                                    RL_ADMIN_TOKEN; without RL_ADMIN_TOKEN nobody can
 *   RL_REGISTRATION=open             self-service, for a hosted instance; limited to
 *                                    RL_REGISTRATION_RATE attempts per client address
 *                                    per hour (default 5)
 *
 * The check runs before any lookup, so the endpoint cannot be used to probe
 * which e-mails are registered. The rate limit is per process and resets on
 * restart; v1.0 runs a single process.
 */

import { ORPCError } from "@orpc/server";
import { timingSafeEqual } from "node:crypto";

type Headers = Record<string, string | string[] | undefined>;

const WINDOW_MS = 60 * 60 * 1000;
const attempts = new Map<string, number[]>();

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clientAddress(headers: Headers): string {
  const forwarded = header(headers, "x-forwarded-for")?.split(",")[0]?.trim();
  return header(headers, "cf-connecting-ip") ?? forwarded ?? "unknown";
}

export function assertRegistrationAllowed(headers: Headers, now = Date.now()): void {
  if ((process.env.RL_REGISTRATION ?? "admin") === "open") {
    const limit = Number(process.env.RL_REGISTRATION_RATE ?? 5);
    const client = clientAddress(headers);
    const recent = (attempts.get(client) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) {
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: "Too many owner registrations from this address; try again later",
      });
    }
    recent.push(now);
    attempts.set(client, recent);
    return;
  }

  const expected = process.env.RL_ADMIN_TOKEN;
  const given = header(headers, "x-admin-token");
  if (!expected || !given || !sameSecret(given, expected)) {
    throw new ORPCError("FORBIDDEN", {
      message: "Owner registration is restricted to administrators",
    });
  }
}

/** Test hook: forget recorded registration attempts. */
export function resetRegistrationAttempts(): void {
  attempts.clear();
}
