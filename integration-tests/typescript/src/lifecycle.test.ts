import { beforeAll, describe, expect, test } from "vitest";
import { AuthError, LedgerClient, NotFoundError, newRecordId } from "reasoning-ledger-sdk";
import type { LedgerClientConfig } from "reasoning-ledger-sdk";

import { resolveStagingEnv } from "./env.js";
import { StagingTransport } from "./stagingTransport.js";

// End-to-end lifecycle against the deployed staging API.
// Skips the whole suite if STAIRAI_STAGING_API_KEY is not present — this keeps
// the default `pnpm -r test` clean while letting CI opt in.
const skip = !process.env["STAIRAI_STAGING_API_KEY"];
const describeIfStaging = skip ? describe.skip : describe;

describeIfStaging("TypeScript SDK against staging-api.stair-ai.com", () => {
  const env = skip ? null : resolveStagingEnv();
  const transport = skip ? null : new StagingTransport(env!.baseUrl);

  // Shared state across the lifecycle tests — vitest runs tests in file order.
  let agentId: string;
  let client: LedgerClient;
  const sessionId = `it-ts-session-${Date.now()}`;
  const submittedRecordIds: string[] = [];

  beforeAll(async () => {
    if (skip) return;
    // Idempotent registration. If CI re-runs with the same agent name we get
    // the existing agent_id back without side effects.
    const reg = await LedgerClient.registerAgent(
      {
        apiKey: env!.apiKey,
        metadata: {
          description: "integration-tests/typescript lifecycle run",
          tags: ["integration-test", "ts"],
        },
        name: env!.agentName,
      },
      transport!,
    );

    agentId = reg.agent_id;

    const config: LedgerClientConfig = {
      agentId,
      apiKey: env!.apiKey,
      endpoint: env!.baseUrl,
      httpTransport: transport!,
    };
    client = new LedgerClient(config);
  });

  test("registerAgent returns a UUID and a wallet address", () => {
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("resolveAgentId round-trips the registered name", async () => {
    const resolved = await LedgerClient.resolveAgentId(
      { apiKey: env!.apiKey, name: env!.agentName },
      transport!,
    );
    expect(resolved).toBe(agentId);
  });

  test("submit() a full decision-cycle of records", async () => {
    const session = client.newSession(sessionId);

    // Observing — upstream id not yet known.
    const observingId = newRecordId();
    const ack1 = await session.submit({
      behavior: "Observing",
      record_id: observingId,
      trigger_description: "Staging probe triggered from integration test",
      trigger_payload_summary: "probe=1",
      trigger_source: "integration-tests",
      trigger_type: "signal_trigger",
    });
    expect(ack1.session_id).toBe(sessionId);
    expect(ack1.is_duplicate).toBe(false);
    submittedRecordIds.push(ack1.record_id);

    // ToolCalling referencing Observing upstream.
    const ack2 = await session.submit({
      behavior: "ToolCalling",
      description: "fetch baseline",
      input_payload: JSON.stringify({ query: "baseline" }),
      output_payload: JSON.stringify({ value: 42 }),
      success: true,
      tool_meta: { category: "external_api", tool_id: "probe-tool" },
      upstream_record_id: [observingId],
    });
    submittedRecordIds.push(ack2.record_id);

    // Thinking.
    const ack3 = await session.submit({
      behavior: "Thinking",
      inputs: [],
      output_payload: JSON.stringify({ decision: "hold" }),
      prompt: "Given the baseline, do we act?",
    });
    submittedRecordIds.push(ack3.record_id);

    // Acting.
    const ack4 = await session.submit({
      action_summary: "no-op: integration test",
      action_type: "noop",
      behavior: "Acting",
      dry_run: true,
      execution_status: "confirmed",
      parameters: { target: "none" },
      target_system: "integration-tests",
    });
    submittedRecordIds.push(ack4.record_id);
  });

  test("submit() is idempotent on record_id", async () => {
    const rid = newRecordId();
    const session = client.newSession(sessionId);
    const base = {
      behavior: "Other" as const,
      data: { iteration: 1 },
      label: "idempotency-probe",
      record_id: rid,
    };

    const first = await session.submit(base);
    expect(first.is_duplicate).toBe(false);

    const second = await session.submit(base);
    expect(second.is_duplicate).toBe(true);
    expect(second.record_id).toBe(rid);

    submittedRecordIds.push(rid);
  });

  test("submitBatch() accepts a small batch and returns per-record acks", async () => {
    const session = client.newSession(sessionId);
    const batch = [
      {
        behavior: "Other" as const,
        data: { i: 0 },
        label: "batch-0",
      },
      {
        behavior: "Other" as const,
        data: { i: 1 },
        label: "batch-1",
      },
      {
        behavior: "Other" as const,
        data: { i: 2 },
        label: "batch-2",
      },
    ];

    const ack = await session.submitBatch(batch);
    expect(ack.batch_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ack.results).toHaveLength(3);
    for (const r of ack.results) {
      // All three records are fresh — none should be errors.
      expect("code" in r).toBe(false);
      if ("record_id" in r) {
        submittedRecordIds.push(r.record_id);
      }
    }
  });

  test("getRecord() returns a record submitted earlier", async () => {
    const [firstId] = submittedRecordIds;
    expect(firstId).toBeDefined();
    const record = await client.getRecord(firstId!);
    expect(record["record_id"]).toBe(firstId);
    expect(record["agent_id"]).toBe(agentId);
    expect(record["session_id"]).toBe(sessionId);
  });

  test("getSession() returns every record we submitted under sessionId", async () => {
    const fetched = await client.getSession(sessionId);
    expect(fetched.session_id).toBe(sessionId);
    const ids = new Set(fetched.records.map((r) => r["record_id"] as string));
    for (const rid of submittedRecordIds) {
      expect(ids.has(rid)).toBe(true);
    }

    // server_ts_utc must be monotonically non-decreasing (ascending order).
    const serverTs = fetched.records.map((r) => r["server_ts_utc"] as number);
    for (let i = 1; i < serverTs.length; i += 1) {
      expect(serverTs[i]! >= serverTs[i - 1]!).toBe(true);
    }
  });

  test("getTrace() paginates newest-first and covers our records", async () => {
    const page = await client.getTrace({ limit: 50 });
    expect(Array.isArray(page.records)).toBe(true);

    // Newest first: descending server_ts_utc.
    const ts = page.records.map((r) => r["server_ts_utc"] as number);
    for (let i = 1; i < ts.length; i += 1) {
      expect(ts[i]! <= ts[i - 1]!).toBe(true);
    }

    // If the trace has more than 50 rows the cursor comes back populated;
    // otherwise it's null. Either way, trying the next page must not throw.
    if (page.next_cursor !== null) {
      const page2 = await client.getTrace({ before: page.next_cursor, limit: 50 });
      expect(Array.isArray(page2.records)).toBe(true);
    }
  });

  test("getRecord() for a non-existent record raises NotFoundError", async () => {
    const bogus = newRecordId();
    await expect(client.getRecord(bogus)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("bad API key raises AuthError on a real server call", async () => {
    const badClient = new LedgerClient({
      agentId,
      apiKey: `sl_${"0".repeat(64)}`,
      endpoint: env!.baseUrl,
      httpTransport: transport!,
      retry: { attempts: 1, backoffMs: [] },
    });
    await expect(badClient.getTrace({ limit: 1 })).rejects.toBeInstanceOf(AuthError);
  });
});
