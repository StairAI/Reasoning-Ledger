/**
 * The access gate's token endpoint (lib/access.ts): an owner exchanges its API
 * key for a short-lived access token to one resource it holds a grant for.
 * RFC 8693 token exchange, form-encoded as RFC 6749 asks:
 *
 *   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
 *   subject_token=<the owner's API key>
 *   subject_token_type=urn:stair:params:oauth:token-type:api-key
 *   resource=https://share.stair-ai.com
 *   scope=share:write              (optional; default: everything granted)
 *
 * Open to unauthenticated callers: the key in the body is the credential. The
 * body is never logged.
 */

import type { APIRoute } from "astro";
import { NO_STORE, accessConfig, exchangeToken, gateOff } from "#/lib/access";

export const prerender = false;

const MAX_BODY = 16 * 1024;

function invalid(description: string): Response {
  return Response.json(
    { error: "invalid_request", error_description: description },
    { headers: NO_STORE, status: 400 },
  );
}

export const POST: APIRoute = async ({ request }) => {
  const config = accessConfig();
  if (!config) {
    return gateOff();
  }
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    await request.body?.cancel();
    return invalid("Send the parameters form-encoded (application/x-www-form-urlencoded)");
  }
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return invalid("The request is too large");
  }
  const result = await exchangeToken(new URLSearchParams(text), config);
  return Response.json(result.body, { headers: NO_STORE, status: result.status });
};
