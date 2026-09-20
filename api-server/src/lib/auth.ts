import { ORPCError, os } from "@orpc/server";
import { prisma } from "#/lib/prisma";
import { hashApiKey } from "#/lib/crypto";

export interface AuthContext {
  ownerId: string;
  walletMode: "custodial" | "byow";
}

/**
 * Base procedure builder with HTTP headers in context (injected by the HTTP handler).
 */
export const base = os.$context<{ headers: Record<string, string | string[] | undefined> }>();

/** Look up the owner behind a raw API key; undefined when the key is unknown. */
export async function ownerForApiKey(raw: string): Promise<AuthContext | undefined> {
  const owner = await prisma.owner.findUnique({
    select: { id: true, wallet_mode: true },
    where: { api_key_hash: hashApiKey(raw) },
  });
  return owner
    ? { ownerId: owner.id, walletMode: owner.wallet_mode as "custodial" | "byow" }
    : undefined;
}

/**
 * Authenticated procedure builder.
 *
 * Reads the `X-API-Key` header, hashes it, looks up the matching Owner,
 * and injects `{ ownerId, walletMode }` into the downstream context.
 * Raises UNAUTHORIZED if the key is missing or unknown.
 */
export const authed = base.use(async ({ context, next }) => {
  const raw = Array.isArray(context.headers["x-api-key"])
    ? context.headers["x-api-key"][0]
    : context.headers["x-api-key"];

  if (!raw) {
    throw new ORPCError("UNAUTHORIZED", { message: "Missing X-API-Key header" });
  }

  const owner = await ownerForApiKey(raw);
  if (!owner) {
    throw new ORPCError("UNAUTHORIZED", { message: "Invalid API key" });
  }

  return next({ context: owner });
});
