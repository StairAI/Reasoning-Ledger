/**
 * The owner behind an API key, as the access gate sees it: handle and live
 * grants (lib/access.ts). Lets a client say which resources it can reach, and
 * under which name, without asking for a token.
 */

import type { APIRoute } from "astro";
import { NO_STORE, accessConfig, gateOff, ownerAccessView } from "#/lib/access";
import { ownerForApiKey } from "#/lib/auth";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  if (!accessConfig()) {
    return gateOff();
  }
  const key = request.headers.get("x-api-key");
  if (!key) {
    return Response.json(
      { message: "Missing X-API-Key header" },
      { headers: NO_STORE, status: 401 },
    );
  }
  const owner = await ownerForApiKey(key);
  if (!owner) {
    return Response.json({ message: "Invalid API key" }, { headers: NO_STORE, status: 401 });
  }
  return Response.json(await ownerAccessView(owner.ownerId), { headers: NO_STORE });
};
