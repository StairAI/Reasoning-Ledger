import { randomUUID } from "node:crypto";

import { SCHEMA_VERSION } from "./constants.js";
import { applyUploaded, encodeContent, isSha256Hex, prepareContent, sha256Hex } from "./content.js";
import type { PendingUpload, PreparedRecord } from "./content.js";
import { ValidationError } from "./errors.js";
import type { ContentRef } from "./generated/records.js";
import { DEFAULT_RETRY, FetchTransport, buildUrl, sendRequest } from "./http.js";
import { Session } from "./session.js";
import type {
  AgentRegistration,
  AttestingInput,
  BatchAck,
  GetTraceOpts,
  HttpTransport,
  LedgerClientConfig,
  RecordAck,
  RecordError,
  RegisterAgentOpts,
  ResolveAgentOpts,
  RetryConfig,
  SessionFetch,
  SessionSubmitInput,
  StoredRecord,
  SubmitInput,
  TracePage,
} from "./types.js";
import { newRecordId, nowEpochMs } from "./utils.js";
import { validateBatch, validateRecord } from "./validate.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The endpoint without trailing slashes; ValidationError when it is missing or blank. */
function resolveEndpoint(endpoint: unknown): string {
  const base = typeof endpoint === "string" ? endpoint.trim().replace(/\/+$/, "") : "";
  if (base === "") {
    throw new ValidationError(
      "endpoint is required: pass the base URL of the Reasoning Ledger API, e.g. https://stg-api.stair-ai.com",
      { field: "endpoint", reason: "missing" },
    );
  }
  return base;
}

function resolveRetry(config: LedgerClientConfig): RetryConfig {
  return config.retry ?? DEFAULT_RETRY;
}

/**
 * Build a complete record from a SubmitInput by auto-filling omitted fields.
 * The caller must supply session_id (client) or have it injected (Session).
 */
function completeRecord(
  input: SubmitInput,
  agentId: string,
  defaultModelInvocation: LedgerClientConfig["defaultModelInvocation"],
): Record<string, unknown> {
  const fields = input as Record<string, unknown>;
  const record: Record<string, unknown> = {
    ...fields,
    agent_id: fields["agent_id"] ?? agentId,
    client_ts_utc: fields["client_ts_utc"] ?? nowEpochMs(),
    record_id: fields["record_id"] ?? newRecordId(),
    schema_version: fields["schema_version"] ?? SCHEMA_VERSION,
  };

  // Apply default model_invocation if the record doesn't set its own.
  if (record["model_invocation"] === undefined && defaultModelInvocation !== undefined) {
    record["model_invocation"] = defaultModelInvocation;
  }

  return record;
}

/** An Attesting record from the Attesting entry point's input. */
function attestingRecord(input: AttestingInput): SubmitInput {
  return {
    ...input,
    behavior: "Attesting",
    executor: "human",
    record_phase: input.record_phase ?? "concurrent",
  };
}

interface BatchEntry {
  /** Raw content that could not be encoded; reported for this record only. */
  error?: ValidationError;
  prepared: PreparedRecord;
}

function prepareForBatch(record: Record<string, unknown>): BatchEntry {
  try {
    return { prepared: prepareContent(record) };
  } catch (error) {
    if (error instanceof ValidationError) {
      // The record keeps its raw content, so it also fails validation and is not sent.
      return { error, prepared: { record, uploads: [] } };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Internal JSON request helper — used by both static and instance methods.
// ---------------------------------------------------------------------------

async function callApi<T>(
  transport: HttpTransport,
  retry: RetryConfig,
  req: {
    apiKey: string;
    body?: unknown;
    method: string;
    url: string;
  },
): Promise<T> {
  const res = await sendRequest(transport, retry, {
    apiKey: req.apiKey,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    contentType: "application/json",
    method: req.method,
    url: req.url,
  });
  return JSON.parse(res.body) as T;
}

// ---------------------------------------------------------------------------
// LedgerClient
// ---------------------------------------------------------------------------

export class LedgerClient {
  private readonly config: LedgerClientConfig;
  private readonly transport: HttpTransport;
  private readonly retry: RetryConfig;
  private readonly baseUrl: string;

  /**
   * @throws ValidationError when `config.endpoint` is missing or blank.
   */
  constructor(config: LedgerClientConfig) {
    this.baseUrl = resolveEndpoint(config.endpoint);
    this.config = config;
    this.transport = config.httpTransport ?? new FetchTransport();
    this.retry = resolveRetry(config);
  }

  // -------------------------------------------------------------------------
  // Static factory methods
  // -------------------------------------------------------------------------

  /**
   * Register a new agent under the owner identified by `apiKey`.
   * Idempotent on `(owner, name)` — repeating the call returns the existing
   * agent without side effects. See §6.4.
   *
   * @param _transport - Optional transport override (used in tests).
   */
  static async registerAgent(
    opts: RegisterAgentOpts,
    _transport: HttpTransport = new FetchTransport(),
  ): Promise<AgentRegistration> {
    const baseUrl = resolveEndpoint(opts.endpoint);
    const body: Record<string, unknown> = { name: opts.name };
    if (opts.metadata?.description !== undefined) {
      body["description"] = opts.metadata.description;
    }
    if (opts.metadata?.website !== undefined) {
      body["website"] = opts.metadata.website;
    }
    if (opts.metadata?.tags !== undefined) {
      body["tags"] = opts.metadata.tags;
    }
    // `signer` is a client-side callback — never sent to the server.
    if (opts.wallet?.address !== undefined) {
      body["wallet"] = { address: opts.wallet.address };
    }

    return await callApi<AgentRegistration>(_transport, DEFAULT_RETRY, {
      apiKey: opts.apiKey,
      body,
      method: "POST",
      url: `${baseUrl}/v1/agents`,
    });
  }

  /**
   * Resolve an agent's UUID by its human-readable name.
   * Best practice: call once at startup and cache the result. See §7.3.
   *
   * @param _transport - Optional transport override (used in tests).
   */
  static async resolveAgentId(
    opts: ResolveAgentOpts,
    _transport: HttpTransport = new FetchTransport(),
  ): Promise<string> {
    const baseUrl = resolveEndpoint(opts.endpoint);
    const data = await callApi<{ agent_id: string }>(_transport, DEFAULT_RETRY, {
      apiKey: opts.apiKey,
      method: "GET",
      url: buildUrl(`${baseUrl}/v1/agents`, { name: opts.name }),
    });
    return data.agent_id;
  }

  // -------------------------------------------------------------------------
  // Content library
  // -------------------------------------------------------------------------

  /**
   * Upload raw content and return its ContentRef. A string is sent as UTF-8
   * (default media type `text/plain; charset=utf-8`), bytes as they are
   * (default `application/octet-stream`). Content is addressed by the SHA-256
   * of its bytes, so the upload is idempotent: content already stored returns
   * the stored reference. Retried on transient errors like other idempotent
   * calls. Content over the server's size limit fails with ValidationError.
   */
  async putContent(data: string | Uint8Array, mediaType?: string): Promise<ContentRef> {
    if (typeof data !== "string" && !(data instanceof Uint8Array)) {
      throw new ValidationError("putContent takes a string or a Uint8Array", {
        field: "data",
        reason: "not a string or bytes",
      });
    }
    if (mediaType !== undefined && (typeof mediaType !== "string" || mediaType.trim() === "")) {
      throw new ValidationError("mediaType must be a non-empty string", {
        field: "mediaType",
        reason: "empty",
      });
    }
    const encoded = encodeContent(data, "data");
    return await this.putBytes(
      encoded.data,
      mediaType ?? encoded.mediaType,
      sha256Hex(encoded.data),
    );
  }

  /**
   * Read content by its ContentRef (or its sha256) and return the raw bytes.
   * Content that does not exist, belongs to another owner, or was deleted
   * raises NotFoundError with the server's message.
   */
  async getContent(ref: ContentRef | string): Promise<Uint8Array> {
    const sha256 = typeof ref === "string" ? ref : ref?.sha256;
    if (!isSha256Hex(sha256)) {
      throw new ValidationError(
        "getContent takes a ContentRef or its sha256 (64 lowercase hex characters)",
        { field: "sha256", reason: "not a lowercase hex SHA-256" },
      );
    }
    const res = await sendRequest(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      method: "GET",
      url: `${this.baseUrl}/v1/content/${sha256}`,
    });
    return res.bodyBytes ?? new TextEncoder().encode(res.body);
  }

  // -------------------------------------------------------------------------
  // Instance methods
  // -------------------------------------------------------------------------

  /**
   * Submit a single record. Auto-fills `agent_id`, `record_id`,
   * `schema_version`, and `client_ts_utc` if omitted. Raw content at a
   * content position (string, bytes or other JSON value) is uploaded and
   * replaced by its ContentRef. Validates locally before anything is sent —
   * uploads included — and retries on transient errors. See §7.5.
   */
  async submit(input: SubmitInput): Promise<RecordAck> {
    const prepared = prepareContent(this.complete(input));
    validateRecord(prepared.record);
    const [record] = await this.withUploads([prepared]);

    return await callApi<RecordAck>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      body: record,
      method: "POST",
      url: `${this.baseUrl}/v1/records`,
    });
  }

  /**
   * Submit an Attesting record: a person's disposition of a pending action.
   * Sets `behavior: "Attesting"` and `executor: "human"`, and `record_phase:
   * "concurrent"` unless the input sets one; otherwise behaves like submit.
   * A reject needs a `reason`. `effects` may be raw content.
   */
  submitAttesting(input: AttestingInput): Promise<RecordAck> {
    return this.submit(attestingRecord(input));
  }

  /**
   * Submit up to 50 records in a single request. Validates each record
   * locally first. Per-record validation failures produce synthetic
   * RecordError entries in the results array — they do not abort the batch.
   * Raw content of the valid records is uploaded before the batch is sent; a
   * failed upload fails the call and nothing is sent. Batch-level failures
   * (count > 50, total > 1 MB, auth) throw immediately. See §7.5.
   */
  async submitBatch(inputs: SubmitInput[]): Promise<BatchAck> {
    // Complete every record and compute its content references locally.
    const entries = inputs.map((input) => prepareForBatch(this.complete(input)));

    // Validate each record locally; collect per-position errors.
    const errors = validateBatch(entries.map((entry) => entry.prepared.record)); // throws on batch-level violations

    // Build the subset of valid records to send, tracking original indices.
    const valid: { index: number; prepared: PreparedRecord }[] = [];
    const results: (RecordAck | RecordError)[] = Array.from(
      { length: inputs.length },
      () => null as unknown as RecordAck | RecordError,
    );

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const err = entry?.error ?? errors[i];
      if (err !== null && err !== undefined) {
        results[i] = {
          code: err.code,
          message: err.message,
          record_id: (entry?.prepared.record["record_id"] as string | undefined) ?? "(unknown)",
        } satisfies RecordError;
      } else if (entry !== undefined) {
        valid.push({ index: i, prepared: entry.prepared });
      }
    }

    if (valid.length === 0) {
      // All records failed local validation; synthesize a batch_id.
      return { batch_id: randomUUID(), results };
    }

    const records = await this.withUploads(valid.map((v) => v.prepared));
    const serverResponse = await callApi<{
      batch_id: string;
      results: (RecordAck | RecordError)[];
    }>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      body: { records },
      method: "POST",
      url: `${this.baseUrl}/v1/records/batch`,
    });

    // Merge server results back into the full results array at the correct indices.
    for (let j = 0; j < valid.length; j += 1) {
      const entry = valid[j];
      const serverResult = serverResponse.results[j];
      if (entry !== undefined && serverResult !== undefined) {
        results[entry.index] = serverResult;
      }
    }

    return { batch_id: serverResponse.batch_id, results };
  }

  /**
   * Fetch a single stored record by `record_id`. See §7.5.
   */
  getRecord(recordId: string): Promise<StoredRecord> {
    return callApi<StoredRecord>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      method: "GET",
      url: `${this.baseUrl}/v1/records/${encodeURIComponent(recordId)}`,
    });
  }

  /**
   * Fetch all records in a session, in the order the server received them
   * (`sequence` ascending). `agent_id` is auto-filled from the client config.
   * See §7.5.
   */
  getSession(sessionId: string): Promise<SessionFetch> {
    const url = buildUrl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
      agent_id: this.config.agentId,
    });
    return callApi<SessionFetch>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      method: "GET",
      url,
    });
  }

  /**
   * Fetch a paginated view of the agent's full trace, newest-first. Pass the
   * previous page's `next_cursor` as `before` to page back. `agent_id` is
   * auto-filled from the client config. See §7.5.
   */
  getTrace(opts: GetTraceOpts = {}): Promise<TracePage> {
    const url = buildUrl(`${this.baseUrl}/v1/traces/${encodeURIComponent(this.config.agentId)}`, {
      before: opts.before,
      limit: opts.limit,
    });
    return callApi<TracePage>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      method: "GET",
      url,
    });
  }

  /**
   * Create a Session bound to the given `session_id` (or a fresh UUID).
   * Local-only convenience; no network call. See §7.5.
   */
  newSession(sessionId?: string): Session {
    return new Session(this, sessionId);
  }

  // -------------------------------------------------------------------------
  // Internal helpers exposed for Session
  // -------------------------------------------------------------------------

  /** @internal */
  _submit(input: SessionSubmitInput): Promise<RecordAck> {
    return this.submit(input as SubmitInput);
  }

  /** @internal */
  _submitBatch(inputs: SessionSubmitInput[]): Promise<BatchAck> {
    return this.submitBatch(inputs as SubmitInput[]);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private complete(input: SubmitInput): Record<string, unknown> {
    return completeRecord(input, this.config.agentId, this.config.defaultModelInvocation);
  }

  private async putBytes(data: Uint8Array, mediaType: string, sha256: string): Promise<ContentRef> {
    const res = await sendRequest(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      body: data,
      contentType: mediaType,
      method: "PUT",
      url: `${this.baseUrl}/v1/content/${sha256}`,
    });
    return JSON.parse(res.body) as ContentRef;
  }

  /**
   * Upload the pending content of `prepared` — each distinct piece once, in
   * order, stopping at the first failure — and return the records with the
   * server's references in place of the locally computed ones.
   */
  private async withUploads(prepared: PreparedRecord[]): Promise<Record<string, unknown>[]> {
    const pending: PendingUpload[] = prepared.flatMap((p) => p.uploads);
    const stored = new Map<string, ContentRef>();
    const uploaded = new Map<unknown, ContentRef>();
    for (const { data, ref } of pending) {
      const key = `${ref.sha256} ${ref.media_type}`;
      let result = stored.get(key);
      if (result === undefined) {
        result = await this.putBytes(data, ref.media_type, ref.sha256);
        stored.set(key, result);
      }
      uploaded.set(ref, result);
    }
    return prepared.map((p) =>
      p.uploads.length > 0 ? applyUploaded(p.record, uploaded) : p.record,
    );
  }
}
