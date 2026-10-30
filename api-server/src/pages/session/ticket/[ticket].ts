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
import { CONTENT_SECURITY_POLICY, PRIVATE_HEADERS, navigationPage } from "#/lib/navigation-page";
import { consumeTicket } from "#/lib/viewer-tickets";
import {
  VIZ_COOKIE,
  endVizSession,
  startVizSession,
  viewerForSession,
  vizCookieOptions,
} from "#/lib/viz-session";

export const prerender = false;

/** Where an unusable ticket sends the browser. */
const SIGN_IN_AGAIN = `/login?next=${encodeURIComponent("/")}&expired=1`;

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
