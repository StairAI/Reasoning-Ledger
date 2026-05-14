// Resolve shared environment variables for staging integration tests.
// All SDK test suites source their config from here so we only have one place
// to document what's required to run against staging.

export interface StagingEnv {
  apiKey: string;
  baseUrl: string;
  agentName: string;
}

const DEFAULT_BASE_URL = "https://staging-api.stair-ai.com";

export function resolveStagingEnv(): StagingEnv {
  const apiKey = process.env["STAIRAI_STAGING_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "STAIRAI_STAGING_API_KEY is not set. Integration tests require an owner-level API key " +
        "issued against https://staging-api.stair-ai.com. See integration-tests/README.md.",
    );
  }

  const baseUrl = (process.env["STAIRAI_STAGING_BASE_URL"] ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  // One agent name per test run so parallel invocations don't collide.
  // registerAgent is idempotent on (owner, name) so reruns are safe, but the
  // timestamp suffix makes each CI job's trace easy to find.
  const defaultName = `it-ts-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const agentName = process.env["STAIRAI_STAGING_AGENT_NAME"] ?? defaultName;

  return { agentName, apiKey, baseUrl };
}
