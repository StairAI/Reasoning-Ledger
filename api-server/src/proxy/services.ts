export interface ServiceConfig {
  name: "sportmonks" | "polymarket";
  baseUrl: string;
  authMethod: "bearer" | "query";
  authKeyName?: string;
  timeout: number;
}

export const SERVICES: Record<string, ServiceConfig> = {
  polymarket: {
    authMethod: "bearer",
    baseUrl: process.env.POLYMARKET_BASE_URL || "https://api.polymarket.com",
    name: "polymarket",
    timeout: 30_000,
  },
  sportmonks: {
    authKeyName: "api_token",
    authMethod: "query",
    baseUrl: process.env.SPORTMONKS_BASE_URL || "https://api.sportmonks.com",
    name: "sportmonks",
    timeout: 30_000,
  },
};

export function getServiceConfig(service: "sportmonks" | "polymarket"): ServiceConfig {
  const config = SERVICES[service];
  if (!config) {
    throw new Error(`Unknown service: ${service}`);
  }
  return config;
}
