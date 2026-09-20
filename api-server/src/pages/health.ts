/**
 * Health check for whoever runs the server: 200 while it can reach its
 * database, 503 when it cannot. Open to unauthenticated callers, because a
 * platform's health check carries no API key, and the answer says nothing
 * beyond up or down.
 */

import type { APIRoute } from "astro";
import { prisma } from "#/lib/prisma";

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "no database" }, { status: 503 });
  }
};
