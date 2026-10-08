/**
 * Visualiser login sessions (design §4.3). A visitor signs in with their own
 * owner token; the page then reads as that owner. The instance administrator
 * signs in with RL_ADMIN_TOKEN and reads across owners (lib/admin.ts). The
 * token itself is never kept: the cookie carries only a random session id
 * (HttpOnly, Secure, SameSite=Strict), and sessions expire after
 * VIZ_SESSION_TTL_HOURS (default 12).
 */

import { randomBytes } from "node:crypto";
import { prisma } from "#/lib/prisma";

export const VIZ_COOKIE = "rl_viz";

function ttlMs(): number {
  const hours = Number(process.env.VIZ_SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000;
}

/** Who a viewer session reads as: one owner, or the administrator (ownerId null). */
export interface Viewer {
  ownerId: string | null;
  admin: boolean;
  /**
   * How the pages name the owner: the display name, else the e-mail, else the
   * id. Unset for the administrator.
   */
  ownerName?: string;
}

/**
 * Start a session for an owner, or for the administrator when ownerId is null.
 * Expired sessions go first: a browser drops its cookie when the session
 * expires, and a sign-in from another site replaces the cookie without sending
 * it, so most sessions are never presented again to be ended.
 */
export async function startVizSession(
  ownerId: string | null,
): Promise<{ id: string; expiresAt: Date }> {
  const now = Date.now();
  await prisma.vizSession.deleteMany({ where: { expires_at: { lte: new Date(now) } } });
  const id = randomBytes(32).toString("hex");
  const expiresAt = new Date(now + ttlMs());
  await prisma.vizSession.create({ data: { expires_at: expiresAt, id, owner_id: ownerId } });
  return { expiresAt, id };
}

/** The viewer behind a session cookie, or undefined when missing, unknown or expired. */
export async function viewerForSession(id?: string): Promise<Viewer | undefined> {
  if (!id) {
    return undefined;
  }
  const session = await prisma.vizSession.findUnique({
    include: { owner: { select: { display_name: true, email: true } } },
    where: { id },
  });
  if (!session) {
    return undefined;
  }
  if (session.expires_at.getTime() <= Date.now()) {
    await prisma.vizSession.deleteMany({ where: { id } });
    return undefined;
  }
  if (session.owner_id === null) {
    return { admin: true, ownerId: null };
  }
  const ownerName = session.owner?.display_name?.trim() || session.owner?.email || session.owner_id;
  return { admin: false, ownerId: session.owner_id, ownerName };
}

export async function endVizSession(id?: string): Promise<void> {
  if (id) {
    await prisma.vizSession.deleteMany({ where: { id } });
  }
}

/**
 * Whether a form post comes from a page of this site. Guards the sign-in and
 * sign-out endpoints against cross-site requests (Astro's own check is off,
 * see astro.config.mjs). Uses the browser's Sec-Fetch-Site when present, else
 * compares the Origin host with the Host header, which a TLS-terminating proxy
 * leaves intact while the scheme may differ.
 */
export function fromThisSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) {
    return fetchSite === "same-origin";
  }
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const SAME_ORIGIN = "http://viewer.invalid";

/** A path that a browser reads as another host: "//host" or "/\host". */
const OTHER_HOST = /^\/[/\\]/;

/**
 * Where to send a visitor after signing in: a path on this site, never another
 * origin. Parsed the way a browser would, so "//host", "/\host" and paths with
 * embedded tabs or newlines cannot leave the site. The parsed result is what is
 * checked, not the input: parsing collapses dot segments, so "/.//host" and
 * "/a/..//host" come out as "//host".
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return "/";
  }
  try {
    const url = new URL(value, SAME_ORIGIN);
    const next = `${url.pathname}${url.search}${url.hash}`;
    const staysHere =
      url.origin === SAME_ORIGIN &&
      !OTHER_HOST.test(next) &&
      new URL(next, SAME_ORIGIN).origin === SAME_ORIGIN;
    return staysHere ? next : "/";
  } catch {
    return "/";
  }
}

export function vizCookieOptions(expiresAt: Date) {
  return {
    expires: expiresAt,
    httpOnly: true,
    path: "/",
    sameSite: "strict" as const,
    secure: true,
  };
}
