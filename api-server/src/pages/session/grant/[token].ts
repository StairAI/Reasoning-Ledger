/**
 * Where a view grant's link sends a person's browser (lib/view-grants.ts):
 *
 *   GET /session/grant/{token}#k={grant key}
 *
 * A grant in force signs the browser in for that grant only: a viewer session
 * that reads the grant's sessions and ends when the grant does. The page keeps
 * the grant key from the fragment, which the browser never sends, in the tab's
 * sessionStorage, as the ticket page keeps a master key, and moves on to the
 * trace list. The link can be opened again until the grant ends; after that,
 * or once revoked, it answers 410 with a page that says so. Any other method
 * answers 405.
 */

import type { APIRoute } from "astro";
import { CONTENT_SECURITY_POLICY, PRIVATE_HEADERS, navigationPage } from "#/lib/navigation-page";
import { grantForToken } from "#/lib/view-grants";
import { VIZ_COOKIE, endVizSession, startVizSession, vizCookieOptions } from "#/lib/viz-session";

export const prerender = false;

const ENDED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<title>Reasoning Ledger</title>
</head>
<body>
<p>This link has ended: the view it granted has expired or was withdrawn. Ask for a new one with <code>stair rl viewer</code>.</p>
</body>
</html>
`;

export const GET: APIRoute = async ({ params, cookies }) => {
  const grant = await grantForToken(params.token);
  if (!grant) {
    return new Response(ENDED_PAGE, {
      headers: {
        ...PRIVATE_HEADERS,
        "content-security-policy": "default-src 'none'",
        "content-type": "text/html; charset=utf-8",
      },
      status: 410,
    });
  }
  // Whatever this browser was signed in as, it now reads as the grant, and only that.
  await endVizSession(cookies.get(VIZ_COOKIE)?.value);
  const session = await startVizSession(grant.ownerId, {
    expiresAt: grant.expiresAt,
    id: grant.id,
  });
  cookies.set(VIZ_COOKIE, session.id, vizCookieOptions(session.expiresAt));
  return new Response(navigationPage("/"), {
    headers: {
      ...PRIVATE_HEADERS,
      "content-security-policy": CONTENT_SECURITY_POLICY,
      "content-type": "text/html; charset=utf-8",
    },
    status: 200,
  });
};

/** A link checker's HEAD learns nothing and opens nothing. */
export const HEAD: APIRoute = () => new Response(null, { headers: PRIVATE_HEADERS, status: 200 });

export const ALL: APIRoute = () =>
  new Response(null, { headers: { ...PRIVATE_HEADERS, allow: "GET, HEAD" }, status: 405 });
