/**
 * Visualiser pages read as the signed-in visitor (design §4.3): every page
 * needs a valid login session, whose owner is exposed as `Astro.locals.ownerId`.
 * The /v1 API (and its reference page at /v1) authenticates each request with
 * its own API key and is not affected; /health answers the platform's check; the login page and built assets stay reachable.
 */

import { defineMiddleware } from "astro:middleware";
import { VIZ_COOKIE, ownerForVizSession } from "#/lib/viz-session";

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
  const ownerId = await ownerForVizSession(context.cookies.get(VIZ_COOKIE)?.value);
  if (!ownerId) {
    return context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }
  context.locals.ownerId = ownerId;
  return next();
});
