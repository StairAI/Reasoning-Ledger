/**
 * One-time sign-in tickets for the trace viewer.
 *
 * An application that holds an owner's API key on its server mints a ticket
 * (POST /v1/viewer/tickets) and sends the person's browser to
 * /session/ticket/{ticket}, which exchanges it for an ordinary viewer session
 * (lib/viz-session.ts). The person never sees the key, and the key never
 * reaches a browser.
 *
 * A ticket is a bearer credential, so it is kept as small as it can be:
 *
 *   - single use: the exchange marks it used in the same statement that checks
 *     it, so two requests racing with one ticket cannot both sign in;
 *   - short-lived: VIZ_TICKET_TTL_SECONDS, 60 by default, clamped to 10..600;
 *   - owner-scoped: only an owner's API key mints one, never the administrator
 *     token, so a ticket can never open the administrator's view of every owner;
 *   - never stored or logged: the database keeps its SHA-256, the log keeps the
 *     owner and the outcome.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "#/lib/prisma";
import { safeNext } from "#/lib/viz-session";

const DEFAULT_TTL_SECONDS = 60;
const MIN_TTL_SECONDS = 10;
const MAX_TTL_SECONDS = 600;

/** 32 random bytes, base64url without padding. */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Where a ticket is exchanged, relative to the server's own origin. */
export const TICKET_PATH = "/session/ticket/";

/** How long a new ticket stays valid, in seconds. */
export function ticketTtlSeconds(): number {
  const raw = process.env.VIZ_TICKET_TTL_SECONDS;
  const seconds = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(seconds)) {
    return DEFAULT_TTL_SECONDS;
  }
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(seconds)));
}

/** What the database keeps in place of a ticket. */
export function hashTicket(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

type Outcome = "issued" | "used" | "already_used" | "expired" | "unknown";

/**
 * One line per issuance and per exchange, on stdout, in the same shape as the
 * administrator's reads (lib/admin.ts). Never the ticket: it would be a
 * working sign-in link for as long as it is valid.
 */
function logTicket(outcome: Outcome, ownerId?: string): void {
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "viewer_ticket",
      outcome,
      ...(ownerId && { owner_id: ownerId }),
    }),
  );
}

/**
 * Mint a ticket that signs a browser into the viewer as this owner, then
 * sends it to `next` (a path on this site; anything else becomes "/").
 */
export async function issueTicket(
  ownerId: string,
  next: string | undefined,
): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ticketTtlSeconds() * 1000);
  // Tickets live for seconds, so whatever has expired can go; used tickets stay
  // until then, which lets a replay be told apart from a guess in the log.
  await prisma.viewerTicket.deleteMany({ where: { expires_at: { lte: now } } });
  await prisma.viewerTicket.create({
    data: {
      expires_at: expiresAt,
      id: hashTicket(ticket),
      next: safeNext(next),
      owner_id: ownerId,
    },
  });
  logTicket("issued", ownerId);
  return { expiresAt, ticket };
}

/**
 * Exchange a ticket: the owner it signs in as and where to go next, or
 * undefined when the ticket is unknown, already used or expired.
 *
 * Checking and marking are one UPDATE … WHERE used_at IS NULL AND expires_at >
 * now: when two requests race with the same ticket, Postgres lets one update
 * the row and re-evaluates the other against the updated row, which no longer
 * matches. No read-then-write window exists.
 */
export async function consumeTicket(
  ticket: string | undefined,
): Promise<{ ownerId: string; next: string } | undefined> {
  if (!(ticket && TICKET_SHAPE.test(ticket))) {
    logTicket("unknown");
    return undefined;
  }
  const id = hashTicket(ticket);
  const now = new Date();
  const [used] = await prisma.viewerTicket.updateManyAndReturn({
    data: { used_at: now },
    select: { next: true, owner_id: true },
    where: { expires_at: { gt: now }, id, used_at: null },
  });
  if (used) {
    logTicket("used", used.owner_id);
    return { next: safeNext(used.next), ownerId: used.owner_id };
  }
  // Only to say in the log why it failed; the caller is told nothing more.
  const row = await prisma.viewerTicket.findUnique({
    select: { owner_id: true, used_at: true },
    where: { id },
  });
  if (row) {
    logTicket(row.used_at ? "already_used" : "expired", row.owner_id);
  } else {
    logTicket("unknown");
  }
  return undefined;
}
