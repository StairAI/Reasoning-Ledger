import { createHash } from "node:crypto";

import { beforeAll, describe, expect, test } from "vitest";
import {
  AuthError,
  FetchTransport,
  LedgerClient,
  NotFoundError,
  ValidationError,
  newRecordId,
} from "reasoning-ledger-sdk";
import type { ContentRef, HttpTransport, StoredRecord } from "reasoning-ledger-sdk";

import { resolveStagingEnv } from "./env.js";

// End-to-end lifecycle against a running API server (STAIRAI_STAGING_BASE_URL).
// Skips the whole suite if STAIRAI_STAGING_API_KEY is not present — this keeps
// the default `pnpm -r test` clean while letting CI opt in.
const skip = !process.env["STAIRAI_STAGING_API_KEY"];
const describeIfStaging = skip ? describe.skip : describe;

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describeIfStaging("TypeScript SDK 1.0 against the API server", () => {
  const env = skip ? null : resolveStagingEnv();

  // Shared state across the lifecycle tests — vitest runs tests in file order.
  let agentId: string;
  let client: LedgerClient;
  const sessionId = `it-ts-session-${Date.now()}`;
  // Every record written under sessionId, in write order.
  const submittedRecordIds: string[] = [];
  const cycle = {
    acting: newRecordId(),
    attesting: "",
    observing: newRecordId(),
    thinking: newRecordId(),
    toolcalling: newRecordId(),
  };
  const operator = { component: "integration-tests", credential: "it-ts" };

  beforeAll(async () => {
    if (skip) return;
    // Idempotent registration. If CI re-runs with the same agent name we get
    // the existing agent_id back without side effects.
    const reg = await LedgerClient.registerAgent({
      apiKey: env!.apiKey,
      endpoint: env!.baseUrl,
      metadata: {
        description: "integration-tests/typescript lifecycle run",
        tags: ["integration-test", "ts"],
      },
      name: env!.agentName,
    });

    agentId = reg.agent_id;
    client = new LedgerClient({ agentId, apiKey: env!.apiKey, endpoint: env!.baseUrl });
  });

  test("registerAgent returns a UUID agent id", () => {
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("resolveAgentId round-trips the registered name", async () => {
    const resolved = await LedgerClient.resolveAgentId({
      apiKey: env!.apiKey,
      endpoint: env!.baseUrl,
      name: env!.agentName,
    });
    expect(resolved).toBe(agentId);
  });

  test("submit() a full decision cycle, uploading raw content on the way", async () => {
    const session = client.newSession(sessionId);

    const observing = await session.submit({
      behavior: "Observing",
      executor: "det",
      record_id: cycle.observing,
      record_phase: "post_execution",
      trigger_description: "Probe triggered from the integration test",
      trigger_payload_summary: "probe=1",
      trigger_source: "integration-tests",
      trigger_type: "signal_trigger",
    });
    expect(observing.session_id).toBe(sessionId);
    expect(observing.is_duplicate).toBe(false);

    // Object payloads: uploaded as application/json.
    await session.submit({
      behavior: "ToolCalling",
      description: "fetch baseline",
      duration_ms: 42,
      executor: "det",
      input_payload: { query: "baseline" },
      outcome: "success",
      output_payload: { value: 42 },
      record_id: cycle.toolcalling,
      record_phase: "post_execution",
      tool_meta: { category: "external_api", tool_id: "probe-tool" },
      upstream_record_id: [cycle.observing],
    });

    // Raw strings: uploaded as text/plain; charset=utf-8.
    await session.submit({
      behavior: "Thinking",
      executor: "ai",
      inputs: [{ input_payload: "baseline is 42", input_record_id: cycle.toolcalling }],
      output_payload: "Hold: nothing to do.",
      prompt: "Given the baseline, do we act?",
      record_id: cycle.thinking,
      record_phase: "post_execution",
      upstream_record_id: [cycle.toolcalling],
    });

    await session.submit({
      action_summary: "no-op: integration test",
      action_type: "noop",
      behavior: "Acting",
      dry_run: true,
      executor: "det",
      execution_status: "simulated",
      parameters: { target: "none" },
      record_id: cycle.acting,
      record_phase: "pre_execution",
      target_system: "integration-tests",
      upstream_record_id: [cycle.thinking],
    });

    // A person approves the action, through the Attesting entry point.
    const attesting = await session.submitAttesting({
      decision: { approved_action: "noop" },
      disposition: "approve",
      gate_kind: "integration-review",
      operator_id: "integration-operator",
      upstream_record_id: [cycle.acting],
      written_by: operator,
    });
    expect(attesting.is_duplicate).toBe(false);
    cycle.attesting = attesting.record_id;

    submittedRecordIds.push(
      cycle.observing,
      cycle.toolcalling,
      cycle.thinking,
      cycle.acting,
      cycle.attesting,
    );
  });

  test("raw content is stored as content references that read back exactly", async () => {
    const tool = await client.getRecord(cycle.toolcalling);
    const input = tool["input_payload"] as ContentRef;
    expect(input.media_type).toBe("application/json");
    expect(JSON.parse(text(await client.getContent(input)))).toEqual({ query: "baseline" });
    const output = tool["output_payload"] as ContentRef;
    expect(JSON.parse(text(await client.getContent(output)))).toEqual({ value: 42 });

    const thinking = await client.getRecord(cycle.thinking);
    const prompt = thinking["prompt"] as ContentRef;
    expect(prompt.media_type).toBe("text/plain; charset=utf-8");
    expect(text(await client.getContent(prompt))).toBe("Given the baseline, do we act?");
    const [first] = thinking["inputs"] as { input_payload: ContentRef; input_record_id: string }[];
    expect(first?.input_record_id).toBe(cycle.toolcalling);
    expect(text(await client.getContent(first!.input_payload))).toBe("baseline is 42");
  });

  test("the Attesting record is human, concurrent, and keeps written_by and the decision", async () => {
    const record = await client.getRecord(cycle.attesting);
    expect(record.behavior).toBe("Attesting");
    expect(record.executor).toBe("human");
    expect(record.record_phase).toBe("concurrent");
    expect(record["disposition"]).toBe("approve");
    expect(record["decision"]).toEqual({ approved_action: "noop" });
    expect(record["written_by"]).toEqual(operator);
    expect(record.upstream_record_id).toEqual([cycle.acting]);
  });

  test("an Attesting reject without a reason fails locally with ValidationError", async () => {
    const requests: string[] = [];
    const inner = new FetchTransport();
    const recording: HttpTransport = {
      request: (req) => {
        requests.push(`${req.method} ${req.url}`);
        return inner.request(req);
      },
    };
    const recordingClient = new LedgerClient({
      agentId,
      apiKey: env!.apiKey,
      endpoint: env!.baseUrl,
      httpTransport: recording,
    });

    await expect(
      recordingClient.newSession(sessionId).submitAttesting({
        disposition: "reject",
        gate_kind: "integration-review",
        operator_id: "integration-operator",
        written_by: operator,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(requests).toEqual([]);
  });

  test("submit() is idempotent on record_id", async () => {
    const rid = newRecordId();
    const session = client.newSession(sessionId);
    const probe = {
      behavior: "Other" as const,
      data: { iteration: 1 },
      executor: "det" as const,
      label: "idempotency-probe",
      record_id: rid,
      record_phase: "post_execution" as const,
    };

    const first = await session.submit(probe);
    expect(first.is_duplicate).toBe(false);

    const second = await session.submit(probe);
    expect(second.is_duplicate).toBe(true);
    expect(second.record_id).toBe(rid);

    submittedRecordIds.push(rid);
  });

  test("submitBatch() accepts a batch of 3 and returns per-record acks", async () => {
    const session = client.newSession(sessionId);
    const ack = await session.submitBatch([
      {
        behavior: "Other",
        data: { i: 0 },
        executor: "det",
        label: "batch-0",
        record_phase: "post_execution",
      },
      {
        behavior: "Other",
        data: { i: 1 },
        executor: "det",
        label: "batch-1",
        record_phase: "post_execution",
      },
      {
        // Raw content in a batch is uploaded before the batch is sent.
        behavior: "Reflecting",
        executor: "ai",
        inputs: [{ input_payload: "batch-0 and batch-1 were written" }],
        output_payload: "The batch path works.",
        record_phase: "post_execution",
      },
    ]);

    expect(ack.batch_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ack.results).toHaveLength(3);
    for (const r of ack.results) {
      // All three records are fresh — none should be errors.
      expect("code" in r).toBe(false);
      if ("is_duplicate" in r) {
        submittedRecordIds.push(r.record_id);
      }
    }
    expect(submittedRecordIds).toHaveLength(9);
  });

  test("getRecord() returns the 0.4 fields and the server-assigned sequence", async () => {
    const record = await client.getRecord(cycle.toolcalling);
    expect(record.record_id).toBe(cycle.toolcalling);
    expect(record.agent_id).toBe(agentId);
    expect(record.session_id).toBe(sessionId);
    expect(record.schema_version).toBe("0.4");
    expect(record.executor).toBe("det");
    expect(record.record_phase).toBe("post_execution");
    expect(record.outcome).toBe("success");
    expect(record.duration_ms).toBe(42);
    expect(Number.isInteger(record.sequence)).toBe(true);
    expect(record.upstream_record_id).toEqual([cycle.observing]);
  });

  test("getSession() returns every record of the session in sequence order", async () => {
    const fetched = await client.getSession(sessionId);
    expect(fetched.session_id).toBe(sessionId);
    expect(fetched.records.map((r) => r.record_id)).toEqual(submittedRecordIds);

    const sequences = fetched.records.map((r) => r.sequence);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
    }
  });

  test("getTrace() pages newest first through next_cursor", async () => {
    const seen: StoredRecord[] = [];
    let before: string | undefined;
    let pages = 0;
    const wanted = new Set(submittedRecordIds);

    while (pages < 50) {
      const page = await client.getTrace({ before, limit: 3 });
      pages += 1;
      expect(page.records.length).toBeLessThanOrEqual(3);
      seen.push(...page.records);
      if (page.next_cursor === null || seen.filter((r) => wanted.has(r.record_id)).length === wanted.size) {
        break;
      }
      expect(page.next_cursor).toMatch(/^\d+$/);
      before = page.next_cursor;
    }

    // More than one page, strictly decreasing sequence across pages, and every
    // record this run wrote is there.
    expect(pages).toBeGreaterThan(1);
    const sequences = seen.map((r) => r.sequence);
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]!).toBeLessThan(sequences[i - 1]!);
    }
    const ids = new Set(seen.map((r) => r.record_id));
    for (const id of submittedRecordIds) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test("putContent() / getContent() round-trip the bytes exactly", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const ref = await client.putContent(bytes);
    expect(ref).toEqual({
      bytes: 256,
      media_type: "application/octet-stream",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });

    const back = await client.getContent(ref);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);

    // Idempotent: the same bytes again return the same reference.
    await expect(client.putContent(bytes)).resolves.toEqual(ref);
  });

  test("getContent() for content that was never uploaded raises NotFoundError", async () => {
    await expect(client.getContent("0".repeat(64))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("getRecord() for a non-existent record raises NotFoundError", async () => {
    const bogus = newRecordId();
    await expect(client.getRecord(bogus)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a wrong API key raises AuthError", async () => {
    const badClient = new LedgerClient({
      agentId,
      apiKey: `sl_${"0".repeat(64)}`,
      endpoint: env!.baseUrl,
      retry: { attempts: 1, backoffMs: [] },
    });
    await expect(badClient.getRecord(cycle.observing)).rejects.toBeInstanceOf(AuthError);
  });
});
