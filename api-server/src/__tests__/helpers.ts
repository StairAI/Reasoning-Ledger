/**
 * Test helpers shared across all route test suites.
 *
 * Uses the real database (DATABASE_URL from .env) so tests are true
 * integration tests.  Each suite creates an isolated owner with a unique
 * e-mail and cleans up all created rows in afterAll.
 */

import "dotenv/config";
import { call } from "@orpc/server";
import { registerOwner } from "#/routes/owners";
import { prisma } from "#/lib/prisma";

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

/** Owner registration is admin-only by default (RL_REGISTRATION=admin); tests hold the token. */
export const TEST_ADMIN_TOKEN = process.env.RL_ADMIN_TOKEN ?? "test-admin-token";
process.env.RL_ADMIN_TOKEN = TEST_ADMIN_TOKEN;

/** Context carrying the administrator token, for registerOwner. */
export function adminCtx() {
  return {
    context: {
      headers: { "x-admin-token": TEST_ADMIN_TOKEN } as Record<
        string,
        string | string[] | undefined
      >,
    },
  };
}

/** Build the raw context that oRPC's `call` expects for `base` procedures. */
export function ctx(apiKey?: string) {
  return {
    context: {
      headers: apiKey
        ? ({ "x-api-key": apiKey } as Record<string, string | string[] | undefined>)
        : ({} as Record<string, string | string[] | undefined>),
    },
  };
}

/** Build a raw Observing record input ready to submit. */
export function makeObservingInput(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    agent_id: agentId,
    behavior: "Observing" as const,
    client_ts_utc: Date.now(),
    executor: "det" as const,
    record_id: crypto.randomUUID(),
    record_phase: "post_execution" as const,
    schema_version: "0.4",
    session_id: `sess-${crypto.randomUUID()}`,
    trigger_description: "Test trigger",
    trigger_payload_summary: "test payload",
    trigger_source: "test-harness",
    trigger_type: "signal_trigger" as const,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test-owner factory
// ---------------------------------------------------------------------------

export interface TestOwner {
  ownerId: string;
  apiKey: string;
  /** Call in afterAll to delete all trace records, agents, and the owner. */
  cleanup: () => Promise<void>;
}

/**
 * Create a fresh owner for a test suite.
 * The e-mail is randomised so suites never collide.
 */
export async function makeTestOwner(
  opts: { walletMode?: "custodial" | "byow"; walletAddress?: string } = {},
): Promise<TestOwner> {
  const email = `test-${crypto.randomUUID()}@example.com`;
  const walletMode = opts.walletMode ?? "custodial";

  const result = await call(
    registerOwner,
    {
      email,
      wallet_mode: walletMode,
      ...(walletMode === "byow" && {
        owner_wallet_address: opts.walletAddress ?? `0x${"a".repeat(64)}`,
      }),
    },
    adminCtx(),
  );

  if (!result.api_key) {
    throw new Error("Expected api_key on new owner");
  }

  const ownerId = result.owner_id;
  const apiKey = result.api_key;

  const cleanup = async () => {
    // Delete in reverse FK order: records → agents → owner.
    const agents = await prisma.agent.findMany({
      select: { id: true },
      where: { owner_id: ownerId },
    });
    if (agents.length > 0) {
      await prisma.traceRecord.deleteMany({
        where: { agent_id: { in: agents.map((a) => a.id) } },
      });
      await prisma.agent.deleteMany({ where: { owner_id: ownerId } });
    }
    await prisma.owner.delete({ where: { id: ownerId } });
  };

  return { apiKey, cleanup, ownerId };
}
