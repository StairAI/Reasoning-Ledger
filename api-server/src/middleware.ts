/**
 * Visualiser pages read as the signed-in visitor (design §4.3): every page
 * needs a valid login session, exposed as `Astro.locals.viewer` — one owner,
 * or the instance administrator, who reads across owners.
 * The /v1 API (and its reference page at /v1) authenticates each request with
 * its own API key and is not affected; /health answers the platform's check; the login page and built assets stay reachable.
 */

import { defineMiddleware } from "astro:middleware";
import { VIZ_COOKIE, viewerForSession } from "#/lib/viz-session";

const OPEN_PATHS = [
  /^\/v1(\/|$)/,
  /^\/health$/,
  /^\/login\/?$/,
  /^\/session$/,
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
