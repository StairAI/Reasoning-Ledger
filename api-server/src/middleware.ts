/**
 * Visualiser pages read as the signed-in visitor (design §4.3): every page
 * needs a valid login session, exposed as `Astro.locals.viewer` — one owner,
 * or the instance administrator, who reads across owners.
 * The /v1 API (and its reference page at /v1) authenticates each request with
 * its own API key and is not affected; /health answers the platform's check; the login page and built assets stay reachable.
 * The access gate (lib/access.ts) is open too: its token endpoint takes the API key in the body, /access/me takes it
 * in a header, and the two documents under /.well-known are public by design.
 * A one-time sign-in link (/session/ticket/{ticket}) is open too: the ticket is the credential; and so is a
 * view grant's link (/session/grant/{token}), whose token is the credential for the grant's sessions only.
 */

import { defineMiddleware } from "astro:middleware";
import { VIZ_COOKIE, viewerForSession } from "#/lib/viz-session";

const OPEN_PATHS = [
  /^\/v1(\/|$)/,
  /^\/health$/,
  /^\/access\/(token|me)$/,
  /^\/\.well-known\/(jwks\.json|oauth-authorization-server)$/,
  /^\/login\/?$/,
  /^\/session$/,
  /^\/session\/ticket\/[^/]+\/?$/,
  /^\/session\/grant\/[^/]+\/?$/,
  /^\/_astro\//,
  /^\/favicon/,
];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;
  if (OPEN_PATHS.some((pattern) => pattern.test(pathname))) {
    return next();
  }
  const viewer = await viewerForSession(context.cookies.get(VIZ_COOKIE)?.value);
  if (!viewer) {
    return context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }
  context.locals.viewer = viewer;
  return next();
});
