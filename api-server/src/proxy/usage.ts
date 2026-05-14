import { prisma } from "#/lib/prisma";

export interface UsageLogEntry {
  proxyKeyId: string;
  service: "sportmonks" | "polymarket";
  method: string;
  path: string;
  statusCode: number;
  responseBytes: number;
  latencyMs: number;
  errorMessage?: string;
}

export async function logUsage(entry: UsageLogEntry): Promise<void> {
  // Insert usage log
  await prisma.proxyUsageLog.create({
    data: {
      error_message: entry.errorMessage,
      latency_ms: entry.latencyMs,
      proxy_key_id: entry.proxyKeyId,
      request_method: entry.method,
      request_path: entry.path,
      response_bytes: entry.responseBytes,
      service: entry.service,
      status_code: entry.statusCode,
    },
  });

  // Increment usage counter
  await prisma.proxyApiKey.update({
    data: {
      current_month_usage: { increment: 1 },
    },
    where: { id: entry.proxyKeyId },
  });
}
