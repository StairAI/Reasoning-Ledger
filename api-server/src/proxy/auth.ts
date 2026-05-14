import type { IncomingMessage } from "node:http";
import { prisma } from "#/lib/prisma";
import { hashApiKey } from "#/lib/crypto";
import { decryptUpstreamKey } from "./crypto";

export interface ProxyAuthContext {
  ownerId: string;
  proxyKeyId: string;
  upstreamKey: string;
  service: "sportmonks" | "polymarket";
}

export async function authenticateProxyRequest(
  req: IncomingMessage,
  service: "sportmonks" | "polymarket",
): Promise<ProxyAuthContext> {
  // Extract API key from header
  const rawKey = Array.isArray(req.headers["x-api-key"])
    ? req.headers["x-api-key"][0]
    : req.headers["x-api-key"];

  if (!rawKey) {
    throw new Error("UNAUTHORIZED: Missing X-API-Key header");
  }

  // Check if it's a proxy key (prefix: `sp_`)
  if (!rawKey.startsWith("sp_")) {
    throw new Error("UNAUTHORIZED: Invalid proxy API key format");
  }

  const hash = hashApiKey(rawKey);

  // Lookup proxy key
  const proxyKey = await prisma.proxyApiKey.findUnique({
    include: {
      owner: {
        select: { id: true },
      },
    },
    where: {
      proxy_key_hash: hash,
    },
  });

  if (!proxyKey || !proxyKey.is_active || proxyKey.service !== service) {
    throw new Error("UNAUTHORIZED: Invalid or inactive proxy API key");
  }

  // Check quota
  if (proxyKey.current_month_usage >= proxyKey.monthly_quota_requests) {
    throw new Error("QUOTA_EXCEEDED: Monthly request quota exceeded");
  }

  // Decrypt upstream key
  const upstreamKey = decryptUpstreamKey(proxyKey.upstream_key_encrypted);

  return {
    ownerId: proxyKey.owner_id,
    proxyKeyId: proxyKey.id,
    service: proxyKey.service as "sportmonks" | "polymarket",
    upstreamKey,
  };
}
