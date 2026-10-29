/**
 * Who may register owners (design §4.1).
 *
 *   RL_REGISTRATION=admin (default)  only requests carrying X-Admin-Token equal to
 *                                    RL_ADMIN_TOKEN or RL_REGISTRATION_TOKEN; with
 *                                    neither configured, nobody can
 *   RL_REGISTRATION=invite           self-service with an invite code (lib/invites.ts),
 *                                    rate-limited like `open`
 *   RL_REGISTRATION=open             self-service, for a hosted instance; limited to
 *                                    RL_REGISTRATION_RATE attempts per client address
 *                                    per hour (default 5)
 *
 * The operator's tokens register in every mode without a code. A code that is
 * supplied is always checked and, when the owner is created, spent and
 * recorded on the owner: switching from `invite` to `open` stops asking for
 * codes without losing who came in with which.
 *
 * The checks run before any lookup, so the endpoint cannot be used to probe
 * which e-mails are registered. The rate limit is per process and resets on
 * restart; v1.0 runs a single process.
 */

import { ORPCError } from "@orpc/server";
import { headerValue, mayRegisterOwners } from "#/lib/admin";
import { assertInviteUsable } from "#/lib/invites";

type Headers = Record<string, string | string[] | undefined>;

export type RegistrationMode = "admin" | "invite" | "open";

export function registrationMode(): RegistrationMode {
  const mode = process.env.RL_REGISTRATION ?? "admin";
  return mode === "open" || mode === "invite" ? mode : "admin";
}

const WINDOW_MS = 60 * 60 * 1000;
const attempts = new Map<string, number[]>();

function clientAddress(headers: Headers): string {
  const forwarded = headerValue(headers, "x-forwarded-for")?.split(",")[0]?.trim();
  return headerValue(headers, "cf-connecting-ip") ?? forwarded ?? "unknown";
}

function countAttempt(headers: Headers, now: number): void {
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
}

/** What a registration was admitted with: the invite code to spend when an owner is created, if any. */
export interface Admission {
  invite: string | null;
}

/** Decide whether this registration may go ahead; throws when it may not. */
export async function admitRegistration(
  headers: Headers,
  inviteCode: string | undefined,
  now = Date.now(),
): Promise<Admission> {
  if (!mayRegisterOwners(headers)) {
    const mode = registrationMode();
    if (mode === "admin") {
      throw new ORPCError("FORBIDDEN", {
        message: "Owner registration is restricted to administrators",
      });
    }
    countAttempt(headers, now);
    if (mode === "invite" && !inviteCode) {
      throw new ORPCError("FORBIDDEN", {
        message: "Owner registration needs an invite code on this ledger",
      });
    }
  }
  return { invite: inviteCode ? await assertInviteUsable(inviteCode) : null };
}

/** Test hook: forget recorded registration attempts. */
export function resetRegistrationAttempts(): void {
  attempts.clear();
}
