import { beforeEach, describe, expect, test } from "vitest";
import { LedgerClient } from "./client.js";
import { ValidationError } from "./errors.js";
import type { HttpRequest, HttpResponse, HttpTransport, LedgerClientConfig } from "./types.js";
import { isValidRecordId } from "./utils.js";

// ---------------------------------------------------------------------------
// Mock transport — answers content uploads like the server; everything else
// from the queue.
// ---------------------------------------------------------------------------

class MockTransport implements HttpTransport {
  calls: HttpRequest[] = [];
  private responses: HttpResponse[] = [];

  enqueue(res: HttpResponse): void {
    this.responses.push(res);
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    if (req.method === "PUT") {
      const bytes = req.body instanceof Uint8Array ? req.body.byteLength : 0;
      const sha256 = req.url.split("/").at(-1);
      return Promise.resolve(ok({ bytes, media_type: req.headers["content-type"], sha256 }, 201));
    }
    const res = this.responses.shift();
    if (res === undefined) {
      return Promise.reject(new Error("MockTransport: no response queued"));
    }
    return Promise.resolve(res);
  }
}

function ok(body: unknown, status = 200): HttpResponse {
  return { body: JSON.stringify(body), headers: {}, status };
}

function jsonBody(req: HttpRequest | undefined): Record<string, unknown> {
  return JSON.parse(typeof req?.body === "string" ? req.body : "{}") as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const API_KEY = `sl_${"a".repeat(64)}`;

function makeConfig(transport: HttpTransport): LedgerClientConfig {
  return {
    agentId: AGENT_ID,
    apiKey: API_KEY,
    endpoint: "http://localhost:3000",
    httpTransport: transport,
    retry: { attempts: 1, backoffMs: [] },
  };
}

const RECORD_ACK = {
  is_duplicate: false,
  record_id: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
  server_ts_utc: 1_700_000_000_123,
  session_id: "session-001",
};

// Module-scope so consistent-function-scoping is satisfied.
function minimalInput() {
  return {
    behavior: "Observing" as const,
    executor: "det" as const,
    record_phase: "post_execution" as const,
    trigger_description: "A thing happened",
    trigger_payload_summary: "summary",
    trigger_source: "webhook",
    trigger_type: "signal_trigger" as const,
  };
}

function attestingInput() {
  return {
    disposition: "approve" as const,
    gate_kind: "manual-review",
    operator_id: "operator-1",
    written_by: { component: "review-ui", credential: "svc-review" },
  };
}

// ---------------------------------------------------------------------------
// Session.id
// ---------------------------------------------------------------------------

describe("Session.id", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new LedgerClient(makeConfig(transport));
  });

  test("uses provided session_id", () => {
    const session = client.newSession("my-session");
    expect(session.id).toBe("my-session");
  });

  test("generates a UUID when session_id is not provided", () => {
    const session = client.newSession();
    expect(isValidRecordId(session.id)).toBeTruthy();
  });

  test("two sessions without explicit id have different ids", () => {
    const s1 = client.newSession();
    const s2 = client.newSession();
    expect(s1.id).not.toBe(s2.id);
  });
});

// ---------------------------------------------------------------------------
// Session.submit — auto-injection of session_id
// ---------------------------------------------------------------------------

describe("Session.submit", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new LedgerClient(makeConfig(transport));
  });

  test("injects session_id into the submitted record", async () => {
    const session = client.newSession("injected-session");
    transport.enqueue(ok({ ...RECORD_ACK, session_id: "injected-session" }));

    await session.submit(minimalInput());

    expect(jsonBody(transport.calls[0])["session_id"]).toBe("injected-session");
  });

  test("caller-supplied session_id is overridden by the session's id", async () => {
    const session = client.newSession("bound-session");
    transport.enqueue(ok({ ...RECORD_ACK, session_id: "bound-session" }));

    await session.submit({ ...minimalInput(), session_id: "caller-supplied" });

    expect(jsonBody(transport.calls[0])["session_id"]).toBe("bound-session");
  });

  test("auto-fills agent_id from client config", async () => {
    const session = client.newSession("s");
    transport.enqueue(ok(RECORD_ACK));

    await session.submit(minimalInput());

    expect(jsonBody(transport.calls[0])["agent_id"]).toBe(AGENT_ID);
  });

  test("uploads raw content before the record is sent", async () => {
    const session = client.newSession("s");
    transport.enqueue(ok(RECORD_ACK));

    await session.submit({
      behavior: "Thinking",
      executor: "ai",
      inputs: [],
      output_payload: "Yes",
      prompt: "Should we act?",
      record_phase: "post_execution",
    });

    expect(transport.calls.map((call) => call.method)).toStrictEqual(["PUT", "PUT", "POST"]);
    const body = jsonBody(transport.calls[2]);
    expect(body["session_id"]).toBe("s");
    expect(body["prompt"]).toHaveProperty("media_type", "text/plain; charset=utf-8");
  });
});

// ---------------------------------------------------------------------------
// Session.submitBatch — auto-injection of session_id on each record
// ---------------------------------------------------------------------------

describe("Session.submitBatch", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new LedgerClient(makeConfig(transport));
  });

  test("injects session_id on every record", async () => {
    const session = client.newSession("batch-session");
    const batchAck = {
      batch_id: "b1",
      results: [RECORD_ACK, RECORD_ACK],
    };
    transport.enqueue(ok(batchAck));

    await session.submitBatch([minimalInput(), minimalInput()]);

    const { records } = jsonBody(transport.calls[0]) as { records: Record<string, unknown>[] };
    expect(records.map((record) => record["session_id"])).toStrictEqual([
      "batch-session",
      "batch-session",
    ]);
  });

  test("returns batch results in original order", async () => {
    const session = client.newSession("s");
    transport.enqueue(
      ok({
        batch_id: "bx",
        results: [
          { ...RECORD_ACK, is_duplicate: false },
          { ...RECORD_ACK, is_duplicate: true },
        ],
      }),
    );

    const ack = await session.submitBatch([minimalInput(), minimalInput()]);
    expect((ack.results[0] as { is_duplicate: boolean }).is_duplicate).toBeFalsy();
    expect((ack.results[1] as { is_duplicate: boolean }).is_duplicate).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Session.submitAttesting
// ---------------------------------------------------------------------------

describe("Session.submitAttesting", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = new LedgerClient(makeConfig(transport));
  });

  test("injects session_id and sets behavior, executor and record_phase", async () => {
    const session = client.newSession("review-session");
    transport.enqueue(ok({ ...RECORD_ACK, session_id: "review-session" }));

    await session.submitAttesting(attestingInput());

    const body = jsonBody(transport.calls[0]);
    expect(body["session_id"]).toBe("review-session");
    expect(body["behavior"]).toBe("Attesting");
    expect(body["executor"]).toBe("human");
    expect(body["record_phase"]).toBe("concurrent");
    expect(body["agent_id"]).toBe(AGENT_ID);
  });

  test("a reject without a reason fails locally", async () => {
    const session = client.newSession("review-session");
    await expect(
      session.submitAttesting({ ...attestingInput(), disposition: "reject" }),
    ).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(0);
  });
});
