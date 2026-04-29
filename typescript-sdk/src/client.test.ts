import { beforeEach, describe, expect, test, vi, expectTypeOf } from "vitest";
import { LedgerClient } from "./client.js";
import { AuthError, NetworkError, ServerError, ValidationError } from "./errors.js";
import type { HttpRequest, HttpResponse, HttpTransport, LedgerClientConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

class MockTransport implements HttpTransport {
  calls: HttpRequest[] = [];
  private responses: HttpResponse[] = [];

  enqueue(res: HttpResponse): void {
    this.responses.push(res);
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const res = this.responses.shift();
    if (res === undefined) {
      return Promise.reject(new Error("MockTransport: no response queued"));
    }
    return Promise.resolve(res);
  }
}

function ok(body: unknown): HttpResponse {
  return { body: JSON.stringify(body), headers: {}, status: 200 };
}

function err(status: number, message: string): HttpResponse {
  return { body: JSON.stringify({ message }), headers: {}, status };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const API_KEY = `sl_${"a".repeat(64)}`;

// Module-scope so consistent-function-scoping is satisfied.
const testSigner = (b: Uint8Array): Promise<Uint8Array> => Promise.resolve(b);

function makeConfig(transport: HttpTransport): LedgerClientConfig {
  return {
    agentId: AGENT_ID,
    apiKey: API_KEY,
    environment: "development",
    httpTransport: transport,
    retry: { attempts: 1, backoffMs: [] }, // no retries in unit tests
  };
}

function makeClient(transport: MockTransport): LedgerClient {
  return new LedgerClient(makeConfig(transport));
}

const RECORD_ACK = {
  is_duplicate: false,
  record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  server_ts_utc: 1_700_000_000_123,
  session_id: "session-001",
};

function minimalObservingInput() {
  return {
    behavior: "Observing" as const,
    session_id: "session-001",
    trigger_description: "A thing happened",
    trigger_payload_summary: "summary",
    trigger_source: "webhook",
    trigger_type: "signal_trigger" as const,
  };
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

describe("LedgerClient.submit", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends POST /v1/records with auto-filled fields", async () => {
    transport.enqueue(ok(RECORD_ACK));
    const ack = await client.submit(minimalObservingInput());

    expect(ack.record_id).toBe(RECORD_ACK.record_id);
    expect(transport.calls).toHaveLength(1);
    const [call] = transport.calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toContain("/v1/records");

    const body = JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
    expect(body["agent_id"]).toBe(AGENT_ID);
    expect(body["schema_version"]).toBe("1.0");
    expectTypeOf(body["record_id"]).toBeString();
    expectTypeOf(body["client_ts_utc"]).toBeNumber();
  });

  test("sends the X-Api-Key header", async () => {
    transport.enqueue(ok(RECORD_ACK));
    await client.submit(minimalObservingInput());
    expect(transport.calls[0]?.headers["x-api-key"]).toBe(API_KEY);
  });

  test("preserves caller-supplied record_id", async () => {
    const customId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    transport.enqueue(ok({ ...RECORD_ACK, record_id: customId }));
    await client.submit({ ...minimalObservingInput(), record_id: customId });
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body["record_id"]).toBe(customId);
  });

  test("applies defaultModelInvocation when record has none", async () => {
    const transportWithDefault = new MockTransport();
    const clientWithDefault = new LedgerClient({
      ...makeConfig(transportWithDefault),
      defaultModelInvocation: { model_name: "claude-opus-4", provider: "anthropic" },
    });
    transportWithDefault.enqueue(ok(RECORD_ACK));
    await clientWithDefault.submit(minimalObservingInput());
    const body = JSON.parse(transportWithDefault.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect((body["model_invocation"] as Record<string, unknown>)?.["provider"]).toBe("anthropic");
  });

  test("record-level model_invocation overrides default", async () => {
    const transportWithDefault = new MockTransport();
    const clientWithDefault = new LedgerClient({
      ...makeConfig(transportWithDefault),
      defaultModelInvocation: { model_name: "claude-opus-4", provider: "anthropic" },
    });
    transportWithDefault.enqueue(ok(RECORD_ACK));
    await clientWithDefault.submit({
      ...minimalObservingInput(),
      model_invocation: { model_name: "gpt-4o", provider: "openai" },
    });
    const body = JSON.parse(transportWithDefault.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect((body["model_invocation"] as Record<string, unknown>)?.["provider"]).toBe("openai");
  });

  test("throws ValidationError for invalid record before making any HTTP call", async () => {
    await expect(
      client.submit({ behavior: "Observing" as const, session_id: "s" } as never),
    ).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(0);
  });

  test("throws AuthError on 401", async () => {
    transport.enqueue(err(401, "Unauthorized"));
    await expect(client.submit(minimalObservingInput())).rejects.toThrow(AuthError);
  });

  test("throws ServerError on 500", async () => {
    transport.enqueue(err(500, "Internal Server Error"));
    await expect(client.submit(minimalObservingInput())).rejects.toThrow(ServerError);
  });

  test("does not retry on 400 (no-retry attempts=1 config)", async () => {
    transport.enqueue(err(400, "Bad Request"));
    await expect(client.submit(minimalObservingInput())).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(1);
  });

  test("returns RecordAck with is_duplicate true on duplicate", async () => {
    transport.enqueue(ok({ ...RECORD_ACK, is_duplicate: true }));
    const ack = await client.submit(minimalObservingInput());
    expect(ack.is_duplicate).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// submitBatch
// ---------------------------------------------------------------------------

describe("LedgerClient.submitBatch", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends POST /v1/records:batch with records array", async () => {
    const batchResponse = {
      batch_id: "batch-123",
      results: [RECORD_ACK, RECORD_ACK],
    };
    transport.enqueue(ok(batchResponse));
    const ack = await client.submitBatch([minimalObservingInput(), minimalObservingInput()]);
    expect(ack.batch_id).toBe("batch-123");
    expect(ack.results).toHaveLength(2);
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as { records: unknown[] };
    expect(body.records).toHaveLength(2);
  });

  test("locally invalid records produce RecordError without HTTP call for valid records", async () => {
    const batchResponse = {
      batch_id: "batch-xyz",
      results: [RECORD_ACK],
    };
    transport.enqueue(ok(batchResponse));

    const invalid = { behavior: "Observing" as const, session_id: "s" } as never;
    const ack = await client.submitBatch([minimalObservingInput(), invalid]);

    expect(ack.results).toHaveLength(2);
    // First record (valid) → RecordAck from server.
    expect((ack.results[0] as { is_duplicate?: boolean }).is_duplicate).toBeFalsy();
    // Second record (invalid) → synthetic RecordError.
    expect((ack.results[1] as { code?: string }).code).toBe("validation_failed");
  });

  test("all invalid records produce synthetic batch_id without HTTP call", async () => {
    const invalid = { behavior: "Observing" as const, session_id: "s" } as never;
    const ack = await client.submitBatch([invalid]);
    expectTypeOf(ack.batch_id).toBeString();
    expect(transport.calls).toHaveLength(0);
    expect((ack.results[0] as { code?: string }).code).toBe("validation_failed");
  });

  test("throws ValidationError when batch exceeds 50 records before HTTP call", async () => {
    const records = Array.from({ length: 51 }, () => minimalObservingInput());
    await expect(client.submitBatch(records)).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getRecord
// ---------------------------------------------------------------------------

describe("LedgerClient.getRecord", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends GET /v1/records/:id", async () => {
    const recordId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
    transport.enqueue(ok({ behavior: "Observing", record_id: recordId }));
    const record = await client.getRecord(recordId);
    expect(record["record_id"]).toBe(recordId);
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.url).toContain(`/v1/records/${recordId}`);
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe("LedgerClient.getSession", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends GET /v1/sessions/:id with agent_id query param", async () => {
    transport.enqueue(ok({ records: [], session_id: "session-001" }));
    await client.getSession("session-001");
    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain("/v1/sessions/session-001");
    expect(url).toContain(`agent_id=${AGENT_ID}`);
  });
});

// ---------------------------------------------------------------------------
// getTrace
// ---------------------------------------------------------------------------

describe("LedgerClient.getTrace", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends GET /v1/traces/:agent_id", async () => {
    transport.enqueue(ok({ next_cursor: null, records: [] }));
    await client.getTrace();
    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain(`/v1/traces/${AGENT_ID}`);
    expect(transport.calls[0]?.method).toBe("GET");
  });

  test("includes before and limit query params when supplied", async () => {
    const cursorId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
    transport.enqueue(ok({ next_cursor: null, records: [] }));
    await client.getTrace({ before: cursorId, limit: 25 });
    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain(`before=${cursorId}`);
    expect(url).toContain("limit=25");
  });
});

// ---------------------------------------------------------------------------
// Retry behaviour (NetworkError)
// ---------------------------------------------------------------------------

describe("LedgerClient retry", () => {
  test("retries on NetworkError up to attempts limit", async () => {
    const transport = new MockTransport();
    const client = new LedgerClient({
      ...makeConfig(transport),
      retry: { attempts: 3, backoffMs: [0, 0] },
    });

    // First two requests throw a network error; third succeeds.
    vi.spyOn(transport, "request")
      .mockRejectedValueOnce(new NetworkError("timeout"))
      .mockRejectedValueOnce(new NetworkError("timeout"))
      .mockResolvedValueOnce(ok(RECORD_ACK));

    const ack = await client.submit(minimalObservingInput());
    expect(ack.record_id).toBe(RECORD_ACK.record_id);
  });

  test("throws NetworkError after exhausting all attempts", async () => {
    const transport = new MockTransport();
    const client = new LedgerClient({
      ...makeConfig(transport),
      retry: { attempts: 2, backoffMs: [0] },
    });

    vi.spyOn(transport, "request").mockRejectedValue(new NetworkError("timeout"));

    await expect(client.submit(minimalObservingInput())).rejects.toThrow(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// static registerAgent / resolveAgentId
// ---------------------------------------------------------------------------

describe("LedgerClient.registerAgent (static)", () => {
  test("sends POST /v1/agents and returns AgentRegistration", async () => {
    const transport = new MockTransport();
    const registration = {
      agent_id: AGENT_ID,
      agent_wallet_address: `0x${"b".repeat(64)}`,
      created_at: 1_700_000_000_000,
      name: "my-agent",
    };
    transport.enqueue(ok(registration));

    const result = await LedgerClient.registerAgent(
      { apiKey: API_KEY, name: "my-agent" },
      transport,
    );
    expect(result.agent_id).toBe(AGENT_ID);
    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toContain("/v1/agents");
  });

  test("includes wallet.address in body when supplied", async () => {
    const transport = new MockTransport();
    transport.enqueue(
      ok({ agent_id: AGENT_ID, agent_wallet_address: "0x1", created_at: 0, name: "n" }),
    );
    await LedgerClient.registerAgent(
      { apiKey: API_KEY, name: "n", wallet: { address: "0xABC" } },
      transport,
    );
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    expect((body["wallet"] as Record<string, unknown>)?.["address"]).toBe("0xABC");
  });

  test("does not include signer in HTTP body", async () => {
    const transport = new MockTransport();
    transport.enqueue(
      ok({ agent_id: AGENT_ID, agent_wallet_address: "0x1", created_at: 0, name: "n" }),
    );
    await LedgerClient.registerAgent(
      { apiKey: API_KEY, name: "n", wallet: { address: "0xABC", signer: testSigner } },
      transport,
    );
    const body = JSON.parse(transport.calls[0]?.body ?? "{}") as Record<string, unknown>;
    const wallet = body["wallet"] as Record<string, unknown> | undefined;
    expect(wallet?.["signer"]).toBeUndefined();
  });
});

describe("LedgerClient.resolveAgentId (static)", () => {
  test("sends GET /v1/agents?name=... and returns agent_id", async () => {
    const transport = new MockTransport();
    transport.enqueue(ok({ agent_id: AGENT_ID, name: "my-agent" }));

    const agentId = await LedgerClient.resolveAgentId(
      { apiKey: API_KEY, name: "my-agent" },
      transport,
    );
    expect(agentId).toBe(AGENT_ID);
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.url).toContain("name=my-agent");
  });
});
