/**
 * The access gate's public signing keys (RFC 7517), which every resource
 * verifies access tokens with. The current key, and the previous one during a
 * rotation (lib/access.ts).
 */

import type { APIRoute } from "astro";
import { accessConfig, gateOff, jwks } from "#/lib/access";

export const prerender = false;

export const GET: APIRoute = () => {
  const config = accessConfig();
  if (!config) {
    return gateOff();
  }
  return Response.json(jwks(config), { headers: { "cache-control": "public, max-age=300" } });
};
