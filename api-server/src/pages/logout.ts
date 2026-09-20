import type { APIRoute } from "astro";
import { VIZ_COOKIE, endVizSession, fromThisSite } from "#/lib/viz-session";

export const prerender = false;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!fromThisSite(request)) {
    return new Response("Sign out from this site", { status: 403 });
  }
  await endVizSession(cookies.get(VIZ_COOKIE)?.value);
  cookies.delete(VIZ_COOKIE, { path: "/" });
  return redirect("/login", 303);
};
