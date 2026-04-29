import { randomUUID } from "node:crypto";

import { ENDPOINTS, SCHEMA_VERSION } from "./constants.js";
import { DEFAULT_RETRY, FetchTransport, buildUrl, mapHttpError, withRetry } from "./http.js";
import { Session } from "./session.js";
import type {
  AgentRegistration,
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
  SubmitInput,
  TracePage,
} from "./types.js";
import { newRecordId, nowEpochMs } from "./utils.js";
import { validateBatch, validateRecord } from "./validate.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(config: LedgerClientConfig): string {
  if (config.endpoint !== undefined) {
    return config.endpoint;
  }
  const env = config.environment ?? "production";
  return ENDPOINTS[env];
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
  const record: Record<string, unknown> = {
    ...input,
    agent_id: (input as Record<string, unknown>)["agent_id"] ?? agentId,
    client_ts_utc: (input as Record<string, unknown>)["client_ts_utc"] ?? nowEpochMs(),
    record_id: (input as Record<string, unknown>)["record_id"] ?? newRecordId(),
    schema_version: (input as Record<string, unknown>)["schema_version"] ?? SCHEMA_VERSION,
  };

  // Apply default model_invocation if the record doesn't set its own.
  if (record["model_invocation"] === undefined && defaultModelInvocation !== undefined) {
    record["model_invocation"] = defaultModelInvocation;
  }

  return record;
}

// ---------------------------------------------------------------------------
// Internal HTTP request helper — used by both static and instance methods.
// ---------------------------------------------------------------------------

function callApi<T>(
  transport: HttpTransport,
  retry: RetryConfig,
  req: {
    apiKey: string;
    body?: unknown;
    method: string;
    url: string;
  },
): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": req.apiKey,
  };

  return withRetry(async () => {
    const res = await transport.request({
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      headers,
      method: req.method,
      url: req.url,
    });

    if (res.status < 200 || res.status >= 300) {
      mapHttpError(res);
    }

    return JSON.parse(res.body) as T;
  }, retry);
}

// ---------------------------------------------------------------------------
// LedgerClient
// ---------------------------------------------------------------------------

export class LedgerClient {
  private readonly config: LedgerClientConfig;
  private readonly transport: HttpTransport;
  private readonly retry: RetryConfig;
  private readonly baseUrl: string;

  constructor(config: LedgerClientConfig) {
    this.config = config;
    this.transport = config.httpTransport ?? new FetchTransport();
    this.retry = resolveRetry(config);
    this.baseUrl = resolveBaseUrl(config);
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
  static registerAgent(
    opts: RegisterAgentOpts,
    _transport: HttpTransport = new FetchTransport(),
  ): Promise<AgentRegistration> {
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

    return callApi<AgentRegistration>(_transport, DEFAULT_RETRY, {
      apiKey: opts.apiKey,
      body,
      method: "POST",
      url: `${ENDPOINTS.production}/v1/agents`,
    });
  }

  /**
   * Resolve an agent's UUID by its human-readable name.
   * Best practice: call once at startup and cache the result. See §7.3.
   *
   * @param _transport - Optional transport override (used in tests).
   */
  static resolveAgentId(
    opts: ResolveAgentOpts,
    _transport: HttpTransport = new FetchTransport(),
  ): Promise<string> {
    const url = buildUrl(`${ENDPOINTS.production}/v1/agents`, { name: opts.name });
    return callApi<{ agent_id: string }>(_transport, DEFAULT_RETRY, {
      apiKey: opts.apiKey,
      method: "GET",
      url,
    }).then((data) => data.agent_id);
  }

  // -------------------------------------------------------------------------
  // Instance methods
  // -------------------------------------------------------------------------

  /**
   * Submit a single record. Auto-fills `agent_id`, `record_id`,
   * `schema_version`, and `client_ts_utc` if omitted. Validates locally
   * before sending; retries on transient errors. See §7.5.
   */
  submit(input: SubmitInput): Promise<RecordAck> {
    const record = completeRecord(input, this.config.agentId, this.config.defaultModelInvocation);
    try {
      validateRecord(record);
    } catch (error) {
      return Promise.reject(error);
    }

    return callApi<RecordAck>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      body: record,
      method: "POST",
      url: `${this.baseUrl}/v1/records`,
    });
  }

  /**
   * Submit up to 50 records in a single request. Validates each record
   * locally first. Per-record validation failures produce synthetic
   * RecordError entries in the results array — they do not abort the batch.
   * Batch-level failures (count > 50, total > 1 MB, auth) throw immediately.
   * See §7.5.
   */
  async submitBatch(inputs: SubmitInput[]): Promise<BatchAck> {
    // Complete all records first.
    const completed = inputs.map((input) =>
      completeRecord(input, this.config.agentId, this.config.defaultModelInvocation),
    );

    // Validate each record locally; collect per-position errors.
    const errors = validateBatch(completed); // throws on batch-level violations

    // Build the subset of valid records to send, tracking original indices.
    const validRecords: { index: number; record: Record<string, unknown> }[] = [];
    const results: (RecordAck | RecordError)[] = Array.from(
      { length: inputs.length },
      () => null as unknown as RecordAck | RecordError,
    );

    for (let i = 0; i < completed.length; i += 1) {
      const err = errors[i];
      if (err !== null && err !== undefined) {
        const record = completed[i];
        results[i] = {
          code: err.code,
          message: err.message,
          record_id: (record?.["record_id"] as string | undefined) ?? "(unknown)",
        } satisfies RecordError;
      } else {
        const record = completed[i];
        if (record !== undefined) {
          validRecords.push({ index: i, record });
        }
      }
    }

    if (validRecords.length === 0) {
      // All records failed local validation; synthesize a batch_id.
      return { batch_id: randomUUID(), results };
    }

    const serverResponse = await callApi<{
      batch_id: string;
      results: (RecordAck | RecordError)[];
    }>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      body: { records: validRecords.map((v) => v.record) },
      method: "POST",
      url: `${this.baseUrl}/v1/records:batch`,
    });

    // Merge server results back into the full results array at the correct indices.
    for (let j = 0; j < validRecords.length; j += 1) {
      const entry = validRecords[j];
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
  getRecord(recordId: string): Promise<Record<string, unknown>> {
    return callApi<Record<string, unknown>>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      method: "GET",
      url: `${this.baseUrl}/v1/records/${recordId}`,
    });
  }

  /**
   * Fetch all records in a session, ordered by `server_ts_utc` ascending.
   * `agent_id` is auto-filled from the client config. See §7.5.
   */
  getSession(sessionId: string): Promise<SessionFetch> {
    const url = buildUrl(`${this.baseUrl}/v1/sessions/${sessionId}`, {
      agent_id: this.config.agentId,
    });
    return callApi<SessionFetch>(this.transport, this.retry, {
      apiKey: this.config.apiKey,
      method: "GET",
      url,
    });
  }

  /**
   * Fetch a paginated view of the agent's full trace, newest-first.
   * `agent_id` is auto-filled from the client config. See §7.5.
   */
  getTrace(opts: GetTraceOpts = {}): Promise<TracePage> {
    const url = buildUrl(`${this.baseUrl}/v1/traces/${this.config.agentId}`, {
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
}
