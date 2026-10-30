/**
 * RFC 8414 metadata for the access gate: issuer, token endpoint, keys and the
 * one grant type it supports (lib/access.ts). A client finds the token
 * endpoint here instead of assuming it lives beside the ledger.
 */

import type { APIRoute } from "astro";
import { accessConfig, authorizationServerMetadata, gateOff } from "#/lib/access";

export const prerender = false;

export const GET: APIRoute = () => {
  const config = accessConfig();
  if (!config) {
    return gateOff();
  }
  return Response.json(authorizationServerMetadata(config), {
    headers: { "cache-control": "public, max-age=300" },
  });
};
