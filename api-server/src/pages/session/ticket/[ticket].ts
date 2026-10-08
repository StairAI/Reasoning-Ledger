/**
 * Where an application sends a person's browser with a one-time ticket from
 * POST /v1/viewer/tickets (lib/viewer-tickets.ts):
 *
 *   GET /session/ticket/{ticket}
 *
 * A good ticket signs the browser in as the ticket's owner and moves on to the
 * page the ticket names. One that is unknown, used or expired goes to the
 * sign-in page, which says the link no longer works, and learns nothing about
 * the ticket: not whether it existed, nor where it pointed. Any other method
 * answers 405 and leaves the ticket unspent.
 *
 * The move on is a tiny page that navigates by itself, not a redirect. The
 * browser arrives here from the application's site, a cross-site navigation,
 * and some browsers keep treating a redirect that follows it as cross-site:
 * the SameSite=Strict session cookie set by this response would not be sent
 * with it, and the visitor would land on the sign-in page. A navigation
 * started by a page of this site is same-site, so the cookie goes with it.
 */

import type { APIRoute } from "astro";
import { createHash } from "node:crypto";
import { consumeTicket } from "#/lib/viewer-tickets";
import {
  VIZ_COOKIE,
  endVizSession,
  startVizSession,
  viewerForSession,
  vizCookieOptions,
} from "#/lib/viz-session";

export const prerender = false;

/**
 * The ticket is in this page's address: keep the response out of every cache,
 * and the address out of the Referer header of whatever the browser loads next.
 */
const PRIVATE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** Where an unusable ticket sends the browser. */
const SIGN_IN_AGAIN = `/login?next=${encodeURIComponent("/")}&expired=1`;

/**
 * The page's only script. It reads the destination from the link rather than
 * holding it, so it never changes and the Content-Security-Policy below can
 * allow exactly this script and nothing else.
 */
const NAVIGATE = 'location.replace(document.getElementById("next").getAttribute("href"));';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(NAVIGATE).digest("base64")}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Escape for an HTML attribute value or text. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Navigate to `next`, a path on this site (safeNext). location.replace keeps
 * the ticket's address out of the back button; the meta refresh covers a
 * browser without scripts, and the link one that does neither.
 */
function navigationPage(next: string): string {
  const href = escapeHtml(next);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0; url=${href}">
<title>Reasoning Ledger</title>
</head>
<body>
<p><a id="next" href="${href}">Continue to Reasoning Ledger</a></p>
<script>${NAVIGATE}</script>
</body>
</html>
`;
}

export const GET: APIRoute = async ({ params, cookies }) => {
  const ticket = await consumeTicket(params.ticket);
  if (!ticket) {
    return new Response(null, {
      headers: { ...PRIVATE_HEADERS, location: SIGN_IN_AGAIN },
      status: 303,
    });
  }

  // The cookie comes along only when the application is on the same site as
  // the viewer; arriving from another site, the browser starts a new session.
  const current = cookies.get(VIZ_COOKIE)?.value;
  const viewer = await viewerForSession(current);
  // Already signed in as this owner: keep that session. Signed in as anyone
  // else, the administrator included, or not at all: the ticket's owner replaces it.
  if (viewer?.ownerId !== ticket.ownerId) {
    await endVizSession(current);
    const session = await startVizSession(ticket.ownerId);
    cookies.set(VIZ_COOKIE, session.id, vizCookieOptions(session.expiresAt));
  }

  return new Response(navigationPage(ticket.next), {
    headers: {
      ...PRIVATE_HEADERS,
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "content-type": "text/html; charset=utf-8",
    },
    status: 200,
  });
};

/**
 * Astro answers HEAD with the GET handler when there is no HEAD handler, and a
 * link checker's HEAD request must not spend the ticket before the person's
 * browser gets to it.
 */
export const HEAD: APIRoute = () => new Response(null, { headers: PRIVATE_HEADERS, status: 200 });

/**
 * Every other method: 405, and the ticket stays unspent. Without a handler
 * Astro answers 404 and logs a warning with the request's path, which here is
 * a working sign-in link. A browser gets here with a POST when an application
 * answers a form post with a 307 or 308 redirect, which repeats the POST.
 */
export const ALL: APIRoute = () =>
  new Response(null, { headers: { ...PRIVATE_HEADERS, allow: "GET, HEAD" }, status: 405 });
