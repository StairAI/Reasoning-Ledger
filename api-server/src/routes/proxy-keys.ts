import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { generateApiKey, hashApiKey } from "#/lib/crypto";
import { authed } from "#/lib/auth";
import { encryptUpstreamKey } from "#/proxy/crypto";

// ---------------------------------------------------------------------------
// POST /v1/proxy-keys
// Issue a new proxy API key for a service
// ---------------------------------------------------------------------------

export const createProxyKey = authed
  .route({
    description:
      "Issue a new proxy API key for Sportmonks or Polymarket. " +
      "Returns the raw key once — it cannot be retrieved again.",
    method: "POST",
    path: "/v1/proxy-keys",
    summary: "Create proxy key",
    tags: ["Proxy Keys"],
  })
  .input(
    z.object({
      monthly_quota_requests: z.number().int().positive().optional(),
      service: z.enum(["sportmonks", "polymarket"]),
      upstream_api_key: z.string().min(1),
    }),
  )
  .output(
    z.object({
      created_at: z.number(),
      proxy_key: z.string(), // shown once
      proxy_key_id: z.string(),
      service: z.enum(["sportmonks", "polymarket"]),
    }),
  )
  .handler(async ({ input, context }) => {
    // Check for existing key
    const existing = await prisma.proxyApiKey.findUnique({
      where: {
        owner_id_service: {
          owner_id: context.ownerId,
          service: input.service,
        },
      },
    });

    if (existing) {
      throw new ORPCError("CONFLICT", {
        message: `A proxy key for ${input.service} already exists for this owner`,
      });
    }

    // Generate proxy key (use sp_ prefix instead of sl_)
    const rawKey = generateApiKey().replace("sl_", "sp_");
    const encryptedUpstream = encryptUpstreamKey(input.upstream_api_key);

    const proxyKey = await prisma.proxyApiKey.create({
      data: {
        monthly_quota_requests: input.monthly_quota_requests ?? 10_000,
        owner_id: context.ownerId,
        proxy_key_hash: hashApiKey(rawKey),
        service: input.service,
        upstream_key_encrypted: encryptedUpstream,
      },
    });

    return {
      created_at: proxyKey.created_at.getTime(),
      proxy_key: rawKey,
      proxy_key_id: proxyKey.id,
      service: proxyKey.service as "sportmonks" | "polymarket",
    };
  });

// ---------------------------------------------------------------------------
// GET /v1/proxy-keys
// List proxy keys for the calling owner
// ---------------------------------------------------------------------------

export const listProxyKeys = authed
  .route({
    description: "List all proxy API keys for the calling owner",
    method: "GET",
    path: "/v1/proxy-keys",
    summary: "List proxy keys",
    tags: ["Proxy Keys"],
  })
  .input(z.object({}))
  .output(
    z.object({
      keys: z.array(
        z.object({
          created_at: z.number(),
          current_month_usage: z.number(),
          is_active: z.boolean(),
          monthly_quota_requests: z.number(),
          proxy_key_id: z.string(),
          service: z.enum(["sportmonks", "polymarket"]),
        }),
      ),
    }),
  )
  .handler(async ({ context }) => {
    const keys = await prisma.proxyApiKey.findMany({
      select: {
        created_at: true,
        current_month_usage: true,
        id: true,
        is_active: true,
        monthly_quota_requests: true,
        service: true,
      },
      where: { owner_id: context.ownerId },
    });

    return {
      keys: keys.map((k) => ({
        created_at: k.created_at.getTime(),
        current_month_usage: k.current_month_usage,
        is_active: k.is_active,
        monthly_quota_requests: k.monthly_quota_requests,
        proxy_key_id: k.id,
        service: k.service as "sportmonks" | "polymarket",
      })),
    };
  });

// ---------------------------------------------------------------------------
// DELETE /v1/proxy-keys/{proxy_key_id}
// Revoke a proxy key
// ---------------------------------------------------------------------------

export const deleteProxyKey = authed
  .route({
    description: "Revoke a proxy API key",
    method: "DELETE",
    path: "/v1/proxy-keys/{proxy_key_id}",
    summary: "Delete proxy key",
    tags: ["Proxy Keys"],
  })
  .input(z.object({ proxy_key_id: z.string().uuid() }))
  .output(z.object({ success: z.boolean() }))
  .handler(async ({ input, context }) => {
    const key = await prisma.proxyApiKey.findUnique({
      where: { id: input.proxy_key_id },
    });

    if (!key || key.owner_id !== context.ownerId) {
      throw new ORPCError("NOT_FOUND", { message: "Proxy key not found" });
    }

    await prisma.proxyApiKey.delete({
      where: { id: input.proxy_key_id },
    });

    return { success: true };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const proxyKeysRouter = {
  createProxyKey,
  deleteProxyKey,
  listProxyKeys,
};
