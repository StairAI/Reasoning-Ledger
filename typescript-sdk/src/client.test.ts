import { createHash } from "node:crypto";

import { beforeEach, describe, expect, expectTypeOf, test, vi } from "vitest";

import { LedgerClient } from "./client.js";
import { AuthError, NetworkError, NotFoundError, ServerError, ValidationError } from "./errors.js";
import type { ContentRef } from "./generated/records.js";
import type {
  ActingRecord,
  AttestingInput,
  AttestingRecord,
  ContentInput,
  HttpRequest,
  HttpResponse,
  HttpTransport,
  LedgerClientConfig,
  RecordError,
  SubmitInput,
} from "./types.js";
import { isValidRecordId } from "./utils.js";

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

class MockTransport implements HttpTransport {
  /** Answer content uploads the way the server does: 201 with the reference. */
  answerUploads = true;
  calls: HttpRequest[] = [];
  private responses: HttpResponse[] = [];

  enqueue(res: HttpResponse): void {
    this.responses.push(res);
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    if (this.answerUploads && req.method === "PUT") {
      return Promise.resolve(storedResponse(req));
    }
    const res = this.responses.shift();
    if (res === undefined) {
      return Promise.reject(new Error("MockTransport: no response queued"));
    }
    return Promise.resolve(res);
  }

  /** Content uploads (PUT /v1/content/…), in order. */
  get uploads(): HttpRequest[] {
    return this.calls.filter((call) => call.method === "PUT");
  }
}

function ok(body: unknown, status = 200): HttpResponse {
  return { body: JSON.stringify(body), headers: {}, status };
}

function err(status: number, message: string): HttpResponse {
  return { body: JSON.stringify({ message }), headers: {}, status };
}

function bytesOf(req: HttpRequest | undefined): Uint8Array {
  const body = req?.body;
  return typeof body === "string" ? new TextEncoder().encode(body) : (body ?? new Uint8Array());
}

function storedResponse(req: HttpRequest): HttpResponse {
  return ok(
    {
      bytes: bytesOf(req).byteLength,
      media_type: req.headers["content-type"],
      sha256: req.url.split("/").at(-1),
    },
    201,
  );
}

function jsonBody(req: HttpRequest | undefined): Record<string, unknown> {
  return JSON.parse(typeof req?.body === "string" ? req.body : "{}") as Record<string, unknown>;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function refOf(data: Uint8Array, mediaType: string): ContentRef {
  return { bytes: data.byteLength, media_type: mediaType, sha256: sha256(data) };
}

function textRef(text: string): ContentRef {
  return refOf(utf8(text), "text/plain; charset=utf-8");
}

function jsonRef(value: unknown): ContentRef {
  return refOf(utf8(JSON.stringify(value)), "application/json");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const API_KEY = `sl_${"a".repeat(64)}`;
const ENDPOINT = "http://localhost:3000";
const SESSION_ID = "session-001";
const UPSTREAM_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const REF: ContentRef = { bytes: 5, media_type: "text/plain", sha256: "b".repeat(64) };

// Module-scope so consistent-function-scoping is satisfied.
const testSigner = (b: Uint8Array): Promise<Uint8Array> => Promise.resolve(b);

function makeConfig(transport: HttpTransport): LedgerClientConfig {
  return {
    agentId: AGENT_ID,
    apiKey: API_KEY,
    endpoint: ENDPOINT,
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
  session_id: SESSION_ID,
};

function minimalObservingInput() {
  return {
    behavior: "Observing" as const,
    executor: "det" as const,
    record_phase: "post_execution" as const,
    session_id: SESSION_ID,
    trigger_description: "A thing happened",
    trigger_payload_summary: "summary",
    trigger_source: "webhook",
    trigger_type: "signal_trigger" as const,
  };
}

function toolCallingInput() {
  return {
    behavior: "ToolCalling" as const,
    description: "echo tool",
    executor: "det" as const,
    input_payload: REF as ContentInput,
    outcome: "success" as const,
    output_payload: REF as ContentInput,
    record_phase: "post_execution" as const,
    session_id: SESSION_ID,
    tool_meta: { name: "echo" },
  };
}

function thinkingInput() {
  return {
    behavior: "Thinking" as const,
    executor: "ai" as const,
    inputs: [],
    output_payload: REF as ContentInput,
    prompt: REF as ContentInput,
    record_phase: "post_execution" as const,
    session_id: SESSION_ID,
  };
}

function attestingInput() {
  return {
    decision: { value: 42 },
    disposition: "approve" as const,
    gate_kind: "manual-review",
    operator_id: "operator-1",
    session_id: SESSION_ID,
    written_by: { component: "review-ui", credential: "svc-review" },
  };
}

// ---------------------------------------------------------------------------
// Input and record types (checked by tsc)
// ---------------------------------------------------------------------------

describe("input and record types", () => {
  test("content positions accept raw content as well as ContentRefs", () => {
    expectTypeOf({ ...toolCallingInput(), input_payload: "text" }).toExtend<SubmitInput>();
    expectTypeOf({
      ...toolCallingInput(),
      input_payload: new Uint8Array(1),
    }).toExtend<SubmitInput>();
    expectTypeOf({ ...toolCallingInput(), input_payload: { n: 1 } }).toExtend<SubmitInput>();
    expectTypeOf({ ...toolCallingInput(), input_payload: REF }).toExtend<SubmitInput>();
    expectTypeOf({
      ...thinkingInput(),
      inputs: [{ input_payload: "raw" }],
    }).toExtend<SubmitInput>();
  });

  test("executor is required, and Acting / Attesting are typed rather than any", () => {
    const { executor: _executor, ...withoutExecutor } = minimalObservingInput();
    expectTypeOf(withoutExecutor).not.toExtend<SubmitInput>();
    expectTypeOf<ActingRecord>().not.toBeAny();
    expectTypeOf<AttestingRecord["executor"]>().toEqualTypeOf<"human">();
    expectTypeOf(attestingInput()).toExtend<AttestingInput>();
    expectTypeOf<AttestingInput>().not.toHaveProperty("behavior");
  });
});

// ---------------------------------------------------------------------------
// endpoint
// ---------------------------------------------------------------------------

describe("LedgerClient endpoint", () => {
  test("is required: a config without one throws ValidationError", () => {
    const config = { ...makeConfig(new MockTransport()), endpoint: undefined };
    expect(() => new LedgerClient(config as unknown as LedgerClientConfig)).toThrow(
      ValidationError,
    );
  });

  test("a blank endpoint throws ValidationError", () => {
    expect(() => new LedgerClient({ ...makeConfig(new MockTransport()), endpoint: "  " })).toThrow(
      ValidationError,
    );
  });

  test("a trailing slash is trimmed", async () => {
    const transport = new MockTransport();
    const client = new LedgerClient({ ...makeConfig(transport), endpoint: `${ENDPOINT}/` });
    transport.enqueue(ok(RECORD_ACK));
    await client.submit(minimalObservingInput());
    expect(transport.calls[0]?.url).toBe(`${ENDPOINT}/v1/records`);
  });

  test("registerAgent and resolveAgentId require one, before any request", async () => {
    const transport = new MockTransport();
    const opts = { apiKey: API_KEY, name: "my-agent" };
    await expect(
      LedgerClient.registerAgent(
        opts as Parameters<typeof LedgerClient.registerAgent>[0],
        transport,
      ),
    ).rejects.toThrow(ValidationError);
    await expect(LedgerClient.resolveAgentId({ ...opts, endpoint: "" }, transport)).rejects.toThrow(
      ValidationError,
    );
    expect(transport.calls).toHaveLength(0);
  });
});

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
    expect(call?.url).toBe(`${ENDPOINT}/v1/records`);

    const body = jsonBody(call);
    expect(body["agent_id"]).toBe(AGENT_ID);
    expect(body["schema_version"]).toBe("0.4");
    expect(body["executor"]).toBe("det");
    expect(body["record_phase"]).toBe("post_execution");
    expect(isValidRecordId(body["record_id"] as string)).toBeTruthy();
    expect(body["client_ts_utc"]).toBeTypeOf("number");
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
    expect(jsonBody(transport.calls[0])["record_id"]).toBe(customId);
  });

  test("applies defaultModelInvocation when record has none", async () => {
    const transportWithDefault = new MockTransport();
    const clientWithDefault = new LedgerClient({
      ...makeConfig(transportWithDefault),
      defaultModelInvocation: { model_name: "claude-opus-4", provider: "anthropic" },
    });
    transportWithDefault.enqueue(ok(RECORD_ACK));
    await clientWithDefault.submit(minimalObservingInput());
    const body = jsonBody(transportWithDefault.calls[0]);
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
    const body = jsonBody(transportWithDefault.calls[0]);
    expect((body["model_invocation"] as Record<string, unknown>)?.["provider"]).toBe("openai");
  });

  test("throws ValidationError for invalid record before making any HTTP call", async () => {
    await expect(
      client.submit({ behavior: "Observing" as const, session_id: "s" } as never),
    ).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(0);
  });

  test("executor and record_phase have no defaults", async () => {
    const { executor: _executor, ...withoutExecutor } = minimalObservingInput();
    const { record_phase: _phase, ...withoutPhase } = minimalObservingInput();
    await expect(client.submit(withoutExecutor as never)).rejects.toThrow(ValidationError);
    await expect(client.submit(withoutPhase as never)).rejects.toThrow(ValidationError);
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
// Raw content at content positions
// ---------------------------------------------------------------------------

describe("LedgerClient.submit — raw content", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
    transport.enqueue(ok(RECORD_ACK));
  });

  test("a string is uploaded as text/plain; charset=utf-8 and replaced by its ContentRef", async () => {
    await client.submit({ ...toolCallingInput(), input_payload: "héllo" });

    const [upload, post] = transport.calls;
    expect(upload?.method).toBe("PUT");
    expect(upload?.url).toBe(`${ENDPOINT}/v1/content/${sha256(utf8("héllo"))}`);
    expect(upload?.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(upload?.headers["x-api-key"]).toBe(API_KEY);
    expect(upload?.body).toStrictEqual(utf8("héllo"));
    expect(post?.url).toBe(`${ENDPOINT}/v1/records`);
    expect(jsonBody(post)["input_payload"]).toStrictEqual(textRef("héllo"));
  });

  test("bytes are uploaded as application/octet-stream", async () => {
    const bytes = new Uint8Array([0, 255, 128, 7]);
    await client.submit({ ...toolCallingInput(), input_payload: bytes });

    const [upload] = transport.uploads;
    expect(upload?.headers["content-type"]).toBe("application/octet-stream");
    expect(upload?.body).toStrictEqual(bytes);
    expect(jsonBody(transport.calls[1])["input_payload"]).toStrictEqual(
      refOf(bytes, "application/octet-stream"),
    );
  });

  test("a JSON object is uploaded compactly as application/json", async () => {
    await client.submit({ ...toolCallingInput(), input_payload: { n: 1, query: "cross-sdk" } });

    const [upload] = transport.uploads;
    expect(upload?.headers["content-type"]).toBe("application/json");
    expect(upload?.body).toStrictEqual(utf8('{"n":1,"query":"cross-sdk"}'));
    expect(jsonBody(transport.calls[1])["input_payload"]).toStrictEqual(
      jsonRef({ n: 1, query: "cross-sdk" }),
    );
  });

  test.each([[[1, 2]], [42], [false], [null]])(
    "the JSON value %j is uploaded as application/json",
    async (value) => {
      await client.submit({ ...toolCallingInput(), output_payload: value });
      const [upload] = transport.uploads;
      expect(upload?.headers["content-type"]).toBe("application/json");
      expect(upload?.body).toStrictEqual(utf8(JSON.stringify(value)));
      expect(jsonBody(transport.calls[1])["output_payload"]).toStrictEqual(jsonRef(value));
    },
  );

  test("a value that is already a ContentRef is sent as is, without an upload", async () => {
    await client.submit(toolCallingInput());
    expect(transport.uploads).toHaveLength(0);
    const body = jsonBody(transport.calls[0]);
    expect(body["input_payload"]).toStrictEqual(REF);
    expect(body["output_payload"]).toStrictEqual(REF);
  });

  test("an object that is not exactly a ContentRef is uploaded as JSON", async () => {
    const lookalike = { ...REF, note: "extra key" };
    await client.submit({ ...toolCallingInput(), input_payload: lookalike });
    expect(transport.uploads).toHaveLength(1);
    expect(jsonBody(transport.calls[1])["input_payload"]).toStrictEqual(jsonRef(lookalike));
  });

  test("covers every content position and uploads before the record is sent", async () => {
    await client.submit({
      ...thinkingInput(),
      inputs: [{ input_payload: { hits: 3 }, input_record_id: UPSTREAM_ID }],
      model_invocation: { internal_reasoning: "because", model_name: "m", provider: "p" },
      output_payload: "Yes",
      prompt: "Should we act?",
    });

    expect(transport.calls.map((call) => call.method)).toStrictEqual([
      "PUT",
      "PUT",
      "PUT",
      "PUT",
      "POST",
    ]);
    const body = jsonBody(transport.calls[4]);
    expect(body["prompt"]).toStrictEqual(textRef("Should we act?"));
    expect(body["output_payload"]).toStrictEqual(textRef("Yes"));
    expect(body["inputs"]).toStrictEqual([
      { input_payload: jsonRef({ hits: 3 }), input_record_id: UPSTREAM_ID },
    ]);
    expect(body["model_invocation"]).toStrictEqual({
      internal_reasoning: textRef("because"),
      model_name: "m",
      provider: "p",
    });
  });

  test("identical content is uploaded once", async () => {
    await client.submit({ ...thinkingInput(), output_payload: "same", prompt: "same" });
    expect(transport.uploads).toHaveLength(1);
    const body = jsonBody(transport.calls[1]);
    expect(body["prompt"]).toStrictEqual(textRef("same"));
    expect(body["output_payload"]).toStrictEqual(textRef("same"));
  });

  test("the record carries the reference the server returned", async () => {
    const own = new MockTransport();
    own.answerUploads = false;
    const stored = { ...textRef("héllo"), media_type: "text/markdown" };
    own.enqueue(ok(stored)); // 200: already stored, under its first media type
    own.enqueue(ok(RECORD_ACK));
    await makeClient(own).submit({ ...toolCallingInput(), input_payload: "héllo" });
    expect(jsonBody(own.calls[1])["input_payload"]).toStrictEqual(stored);
  });

  test("a failed upload fails the submit and the record is not sent", async () => {
    const failing = new MockTransport();
    failing.answerUploads = false;
    failing.enqueue(err(503, "unavailable"));
    await expect(
      makeClient(failing).submit({ ...toolCallingInput(), input_payload: "héllo" }),
    ).rejects.toThrow(ServerError);
    expect(failing.calls.map((call) => call.method)).toStrictEqual(["PUT"]);
  });

  test("an invalid record fails locally before anything is uploaded", async () => {
    const { executor: _executor, ...withoutExecutor } = toolCallingInput();
    await expect(
      client.submit({ ...withoutExecutor, input_payload: "héllo" } as never),
    ).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(0);
  });

  test("the caller's input is not modified", async () => {
    const input = { ...thinkingInput(), inputs: [{ input_payload: "raw" }], prompt: "raw prompt" };
    await client.submit(input);
    expect(input.prompt).toBe("raw prompt");
    expect(input.inputs[0]?.input_payload).toBe("raw");
  });
});

// ---------------------------------------------------------------------------
// putContent / getContent
// ---------------------------------------------------------------------------

describe("LedgerClient.putContent", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("PUTs the UTF-8 bytes of a string to /v1/content/{sha256} and returns the ContentRef", async () => {
    const ref = await client.putContent("héllo");

    const [call] = transport.calls;
    expect(call?.method).toBe("PUT");
    expect(call?.url).toBe(`${ENDPOINT}/v1/content/${sha256(utf8("héllo"))}`);
    expect(call?.headers["x-api-key"]).toBe(API_KEY);
    expect(call?.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(call?.body).toStrictEqual(utf8("héllo"));
    expect(ref).toStrictEqual(textRef("héllo"));
  });

  test("bytes default to application/octet-stream", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const ref = await client.putContent(bytes);
    expect(transport.calls[0]?.headers["content-type"]).toBe("application/octet-stream");
    expect(transport.calls[0]?.body).toStrictEqual(bytes);
    expect(ref).toStrictEqual(refOf(bytes, "application/octet-stream"));
  });

  test("an explicit media type is sent as given", async () => {
    const ref = await client.putContent('{"a":1}', "application/json");
    expect(transport.calls[0]?.headers["content-type"]).toBe("application/json");
    expect(ref.media_type).toBe("application/json");
  });

  test("returns the server's reference when the content is already stored (200)", async () => {
    transport.answerUploads = false;
    const stored = { ...textRef("héllo"), media_type: "text/markdown" };
    transport.enqueue(ok(stored));
    await expect(client.putContent("héllo")).resolves.toStrictEqual(stored);
  });

  test("413 raises a clear ValidationError", async () => {
    transport.answerUploads = false;
    transport.enqueue(err(413, "content exceeds the 67108864-byte limit"));
    const error = await rejectionOf(client.putContent("big"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain("too large");
    expect((error as ValidationError).message).toContain("67108864-byte limit");
  });

  test("400 (hash mismatch) raises ValidationError and 401 raises AuthError", async () => {
    transport.answerUploads = false;
    transport.enqueue(err(400, "body hashes to x, not y"));
    transport.enqueue(err(401, "Invalid API key"));
    await expect(client.putContent("a")).rejects.toThrow(ValidationError);
    await expect(client.putContent("a")).rejects.toThrow(AuthError);
  });

  test("retries transient failures like other idempotent calls", async () => {
    const flaky = new MockTransport();
    flaky.answerUploads = false;
    flaky.enqueue(err(503, "unavailable"));
    flaky.enqueue(ok(textRef("héllo"), 201));
    const retrying = new LedgerClient({
      ...makeConfig(flaky),
      retry: { attempts: 2, backoffMs: [0] },
    });
    await expect(retrying.putContent("héllo")).resolves.toStrictEqual(textRef("héllo"));
    expect(flaky.calls).toHaveLength(2);
    expect(flaky.calls[1]?.body).toStrictEqual(utf8("héllo"));
  });

  test("rejects anything but a string or bytes, and an empty media type, before any request", async () => {
    await expect(client.putContent(42 as never)).rejects.toThrow(ValidationError);
    await expect(client.putContent("a", "")).rejects.toThrow(ValidationError);
    expect(transport.calls).toHaveLength(0);
  });
});

describe("LedgerClient.getContent", () => {
  let transport: MockTransport;
  let client: LedgerClient;
  const bytes = new Uint8Array([0, 255, 128, 7]);
  const ref = refOf(bytes, "application/octet-stream");

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("GETs /v1/content/{sha256} with the API key and returns the raw bytes", async () => {
    transport.enqueue({ body: "", bodyBytes: bytes, headers: {}, status: 200 });
    await expect(client.getContent(ref)).resolves.toStrictEqual(bytes);
    const [call] = transport.calls;
    expect(call?.method).toBe("GET");
    expect(call?.url).toBe(`${ENDPOINT}/v1/content/${ref.sha256}`);
    expect(call?.headers["x-api-key"]).toBe(API_KEY);
  });

  test("accepts the sha256 on its own", async () => {
    transport.enqueue({ body: "", bodyBytes: bytes, headers: {}, status: 200 });
    await expect(client.getContent(ref.sha256)).resolves.toStrictEqual(bytes);
    expect(transport.calls[0]?.url).toBe(`${ENDPOINT}/v1/content/${ref.sha256}`);
  });

  test("falls back to the UTF-8 text body when the transport gives no bytes", async () => {
    transport.enqueue({ body: "héllo", headers: {}, status: 200 });
    await expect(client.getContent(textRef("héllo"))).resolves.toStrictEqual(utf8("héllo"));
  });

  test.each([
    [404, "Content not found"],
    [410, "Content was deleted"],
  ])("%i raises NotFoundError with the server's message", async (status, message) => {
    transport.enqueue(err(status, message));
    const error = await rejectionOf(client.getContent(ref));
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toBe(message);
  });

  test("rejects a malformed sha256 before any request", async () => {
    await expect(client.getContent("ABC")).rejects.toThrow(ValidationError);
    await expect(client.getContent({ ...ref, sha256: "A".repeat(64) })).rejects.toThrow(
      ValidationError,
    );
    expect(transport.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// submitAttesting
// ---------------------------------------------------------------------------

describe("LedgerClient.submitAttesting", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sets behavior Attesting, executor human and record_phase concurrent, and auto-fills", async () => {
    transport.enqueue(ok(RECORD_ACK));
    await client.submitAttesting(attestingInput());

    const [call] = transport.calls;
    expect(call?.url).toBe(`${ENDPOINT}/v1/records`);
    const body = jsonBody(call);
    expect(body["behavior"]).toBe("Attesting");
    expect(body["executor"]).toBe("human");
    expect(body["record_phase"]).toBe("concurrent");
    expect(body["agent_id"]).toBe(AGENT_ID);
    expect(body["schema_version"]).toBe("0.4");
    expect(isValidRecordId(body["record_id"] as string)).toBeTruthy();
    expect(body["client_ts_utc"]).toBeTypeOf("number");
    expect(body["decision"]).toStrictEqual({ value: 42 });
    expect(body["written_by"]).toStrictEqual({ component: "review-ui", credential: "svc-review" });
  });

  test("keeps a record_phase the caller supplies", async () => {
    transport.enqueue(ok(RECORD_ACK));
    await client.submitAttesting({ ...attestingInput(), record_phase: "post_execution" });
    expect(jsonBody(transport.calls[0])["record_phase"]).toBe("post_execution");
  });

  test("uploads raw effects; evidence_refs are sent as given", async () => {
    transport.enqueue(ok(RECORD_ACK));
    await client.submitAttesting({
      ...attestingInput(),
      effects: { rules_changed: 1 },
      evidence_refs: [UPSTREAM_ID, REF],
    });
    expect(transport.uploads).toHaveLength(1);
    const body = jsonBody(transport.calls[1]);
    expect(body["effects"]).toStrictEqual(jsonRef({ rules_changed: 1 }));
    expect(body["evidence_refs"]).toStrictEqual([UPSTREAM_ID, REF]);
  });

  test("a reject without a reason fails locally with ValidationError", async () => {
    const error = await rejectionOf(
      client.submitAttesting({ ...attestingInput(), disposition: "reject" }),
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toHaveProperty("field", "reason");
    expect(transport.calls).toHaveLength(0);
  });

  test("a reject with a reason is sent", async () => {
    transport.enqueue(ok(RECORD_ACK));
    await client.submitAttesting({
      ...attestingInput(),
      disposition: "reject",
      reason: "amount exceeds the approved budget",
    });
    expect(jsonBody(transport.calls[0])["reason"]).toBe("amount exceeds the approved budget");
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

  test("sends POST /v1/records/batch with records array", async () => {
    const batchResponse = {
      batch_id: "batch-123",
      results: [RECORD_ACK, RECORD_ACK],
    };
    transport.enqueue(ok(batchResponse));
    const ack = await client.submitBatch([minimalObservingInput(), minimalObservingInput()]);
    expect(ack.batch_id).toBe("batch-123");
    expect(ack.results).toHaveLength(2);
    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toBe(`${ENDPOINT}/v1/records/batch`);
    const body = jsonBody(transport.calls[0]) as { records: unknown[] };
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

  test("uploads the raw content of the valid records, then posts the batch", async () => {
    transport.enqueue(ok({ batch_id: "b1", results: [RECORD_ACK, RECORD_ACK] }));
    const { executor: _executor, ...withoutExecutor } = toolCallingInput();
    const ack = await client.submitBatch([
      { ...toolCallingInput(), input_payload: "first" },
      { ...withoutExecutor, input_payload: "invalid record" } as never,
      { ...thinkingInput(), prompt: "third" },
    ]);

    expect(transport.calls.map((call) => call.method)).toStrictEqual(["PUT", "PUT", "POST"]);
    expect(transport.uploads.map((call) => call.body)).toStrictEqual([
      utf8("first"),
      utf8("third"),
    ]);
    const { records } = jsonBody(transport.calls[2]) as { records: Record<string, unknown>[] };
    expect(records).toHaveLength(2);
    expect(records[0]?.["input_payload"]).toStrictEqual(textRef("first"));
    expect(records[1]?.["prompt"]).toStrictEqual(textRef("third"));
    expect((ack.results[1] as RecordError).code).toBe("validation_failed");
  });

  test("a failed upload fails the batch before it is posted", async () => {
    transport.answerUploads = false;
    transport.enqueue(err(503, "unavailable"));
    await expect(
      client.submitBatch([minimalObservingInput(), { ...toolCallingInput(), input_payload: "x" }]),
    ).rejects.toThrow(ServerError);
    expect(transport.calls.map((call) => call.method)).toStrictEqual(["PUT"]);
  });

  test("raw content that cannot be encoded fails only its own record", async () => {
    transport.enqueue(ok({ batch_id: "b2", results: [RECORD_ACK] }));
    const ack = await client.submitBatch([
      minimalObservingInput(),
      { ...toolCallingInput(), input_payload: 10n as unknown as ContentInput },
    ]);
    const failure = ack.results[1] as RecordError;
    expect(failure.code).toBe("validation_failed");
    expect(failure.message).toContain("input_payload");
    expect((jsonBody(transport.calls[0]) as { records: unknown[] }).records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getRecord / getSession / getTrace
// ---------------------------------------------------------------------------

describe("LedgerClient.getRecord", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends GET /v1/records/:id with the API key", async () => {
    const recordId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
    transport.enqueue(
      ok({ behavior: "Observing", executor: "det", record_id: recordId, sequence: 7 }),
    );
    const record = await client.getRecord(recordId);
    expect(record.record_id).toBe(recordId);
    expect(record.sequence).toBe(7);
    expect(record.executor).toBe("det");
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.url).toBe(`${ENDPOINT}/v1/records/${recordId}`);
    expect(transport.calls[0]?.headers["x-api-key"]).toBe(API_KEY);
  });
});

describe("LedgerClient.getSession", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends GET /v1/sessions/:id with agent_id query param and the API key", async () => {
    transport.enqueue(ok({ records: [], session_id: SESSION_ID }));
    await client.getSession(SESSION_ID);
    const url = transport.calls[0]?.url ?? "";
    expect(url).toContain(`/v1/sessions/${SESSION_ID}`);
    expect(url).toContain(`agent_id=${AGENT_ID}`);
    expect(transport.calls[0]?.headers["x-api-key"]).toBe(API_KEY);
  });
});

describe("LedgerClient.getTrace", () => {
  let transport: MockTransport;
  let client: LedgerClient;

  beforeEach(() => {
    transport = new MockTransport();
    client = makeClient(transport);
  });

  test("sends GET /v1/traces/:agent_id with the API key", async () => {
    transport.enqueue(ok({ next_cursor: null, records: [] }));
    await client.getTrace();
    const url = transport.calls[0]?.url ?? "";
    expect(url).toBe(`${ENDPOINT}/v1/traces/${AGENT_ID}`);
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.headers["x-api-key"]).toBe(API_KEY);
  });

  test("passes next_cursor through as before — a decimal string, not validated as a UUID", async () => {
    transport.enqueue(ok({ next_cursor: "1041", records: [] }));
    transport.enqueue(ok({ next_cursor: null, records: [] }));

    const first = await client.getTrace({ limit: 25 });
    await client.getTrace({ before: first.next_cursor ?? undefined, limit: 25 });

    const url = transport.calls[1]?.url ?? "";
    expect(url).toContain("before=1041");
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
  test("sends POST {endpoint}/v1/agents and returns AgentRegistration", async () => {
    const transport = new MockTransport();
    const registration = {
      agent_id: AGENT_ID,
      agent_wallet_address: `0x${"b".repeat(64)}`,
      created_at: 1_700_000_000_000,
      name: "my-agent",
    };
    transport.enqueue(ok(registration));

    const result = await LedgerClient.registerAgent(
      { apiKey: API_KEY, endpoint: "https://ledger.example/", name: "my-agent" },
      transport,
    );
    expect(result.agent_id).toBe(AGENT_ID);
    expect(transport.calls[0]?.method).toBe("POST");
    expect(transport.calls[0]?.url).toBe("https://ledger.example/v1/agents");
  });

  test("includes wallet.address in body when supplied", async () => {
    const transport = new MockTransport();
    transport.enqueue(
      ok({ agent_id: AGENT_ID, agent_wallet_address: "0x1", created_at: 0, name: "n" }),
    );
    await LedgerClient.registerAgent(
      { apiKey: API_KEY, endpoint: ENDPOINT, name: "n", wallet: { address: "0xABC" } },
      transport,
    );
    const body = jsonBody(transport.calls[0]);
    expect((body["wallet"] as Record<string, unknown>)?.["address"]).toBe("0xABC");
  });

  test("does not include signer in HTTP body", async () => {
    const transport = new MockTransport();
    transport.enqueue(
      ok({ agent_id: AGENT_ID, agent_wallet_address: null, created_at: 0, name: "n" }),
    );
    const result = await LedgerClient.registerAgent(
      {
        apiKey: API_KEY,
        endpoint: ENDPOINT,
        name: "n",
        wallet: { address: "0xABC", signer: testSigner },
      },
      transport,
    );
    const wallet = jsonBody(transport.calls[0])["wallet"] as Record<string, unknown> | undefined;
    expect(wallet?.["signer"]).toBeUndefined();
    expect(result.agent_wallet_address).toBeNull();
  });
});

describe("LedgerClient.resolveAgentId (static)", () => {
  test("sends GET {endpoint}/v1/agents?name=... and returns agent_id", async () => {
    const transport = new MockTransport();
    transport.enqueue(ok({ agent_id: AGENT_ID, name: "my-agent" }));

    const agentId = await LedgerClient.resolveAgentId(
      { apiKey: API_KEY, endpoint: ENDPOINT, name: "my-agent" },
      transport,
    );
    expect(agentId).toBe(AGENT_ID);
    expect(transport.calls[0]?.method).toBe("GET");
    expect(transport.calls[0]?.url).toBe(`${ENDPOINT}/v1/agents?name=my-agent`);
  });
});
