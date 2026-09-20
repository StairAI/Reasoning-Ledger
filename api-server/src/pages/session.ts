import type { APIRoute } from "astro";
import { ownerForApiKey } from "#/lib/auth";
import {
  VIZ_COOKIE,
  fromThisSite,
  safeNext,
  startVizSession,
  vizCookieOptions,
} from "#/lib/viz-session";

export const prerender = false;

/** Sign in from the login form: exchange an owner token for a session cookie. */
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  if (!fromThisSite(request)) {
    return new Response("Sign in from this site's login page", { status: 403 });
  }
  const form = await request.formData();
  const next = safeNext(form.get("next"));
  const token = String(form.get("token") ?? "").trim();
  const owner = token ? await ownerForApiKey(token) : undefined;
  if (!owner) {
    return redirect(`/login?error=1&next=${encodeURIComponent(next)}`, 303);
  }
  const session = await startVizSession(owner.ownerId);
  cookies.set(VIZ_COOKIE, session.id, vizCookieOptions(session.expiresAt));
  return redirect(next, 303);
};
