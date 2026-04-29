import type {
  ModelInvocation as GeneratedModelInvocation,
  Record as LedgerRecord,
} from "./generated/records.js";

// ---------------------------------------------------------------------------
// Re-export ModelInvocation for consumers who want the type directly.
// ---------------------------------------------------------------------------

export type { GeneratedModelInvocation as ModelInvocation };

// ---------------------------------------------------------------------------
// MakeOptional — makes specified keys optional on each member of a union.
// Distributive so it works correctly with discriminated union types.
// PropertyKey = string | number | symbol (avoids the `keyof any` lint rule).
// ---------------------------------------------------------------------------

export type MakeOptional<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>> & Partial<Pick<T, Extract<keyof T, K>>>
  : never;

// ---------------------------------------------------------------------------
// Auto-filled fields — the SDK stamps these if the caller omits them.
// ---------------------------------------------------------------------------

type AutoFilled = "agent_id" | "client_ts_utc" | "record_id" | "schema_version";

// ---------------------------------------------------------------------------
// SubmitInput — full Record type with auto-filled fields made optional.
// Callers are still required to supply session_id (unless using Session).
// ---------------------------------------------------------------------------

export type SubmitInput = MakeOptional<LedgerRecord, AutoFilled>;

// ---------------------------------------------------------------------------
// SessionSubmitInput — additionally makes session_id optional (Session injects it).
// ---------------------------------------------------------------------------

export type SessionSubmitInput = MakeOptional<LedgerRecord, AutoFilled | "session_id">;

// ---------------------------------------------------------------------------
// HTTP transport abstraction — used for testing and custom instrumentation.
// ---------------------------------------------------------------------------

export interface HttpRequest {
  body?: string;
  headers: Record<string, string>;
  method: string;
  url: string;
}

export interface HttpResponse {
  body: string;
  headers: Record<string, string>;
  status: number;
}

export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

// ---------------------------------------------------------------------------
// Retry configuration.
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Default [500, 1000, 2000] ms delays between successive attempts. */
  backoffMs: number[];
  /** Total number of attempts including the initial one. Default 3. */
  attempts: number;
}

// ---------------------------------------------------------------------------
// LedgerClientConfig — passed to the LedgerClient constructor.
// ---------------------------------------------------------------------------

export interface LedgerClientConfig {
  /** Owner-level API key (issued out-of-band at owner registration). */
  apiKey: string;
  /** UUID v4 agent ID returned by registerAgent or resolveAgentId. */
  agentId: string;
  /**
   * Default ModelInvocation applied to every submitted record unless
   * the record sets its own model_invocation.
   */
  defaultModelInvocation?: GeneratedModelInvocation;
  /**
   * Override base URL. Takes precedence over `environment`.
   */
  endpoint?: string;
  /** Target environment. Defaults to "production". */
  environment?: "development" | "production" | "staging";
  /**
   * Override HTTP transport. Defaults to FetchTransport.
   * Inject a mock here in tests to avoid real network calls.
   */
  httpTransport?: HttpTransport;
  /** Retry configuration. */
  retry?: RetryConfig;
}

// ---------------------------------------------------------------------------
// Static method option types.
// ---------------------------------------------------------------------------

export interface AgentWalletInput {
  /** Partner-owned SUI address recorded as the agent's anchor author. */
  address: string;
  /**
   * BYOW signer callback — v0.1 forward-compatibility stub.
   * Accepted and stored client-side; never invoked in v0.1 because
   * the anchoring pipeline does not produce transactions until v1.
   */
  signer?: (txBytes: Uint8Array) => Promise<Uint8Array>;
}

export interface AgentMetadata {
  description?: string;
  tags?: string[];
  website?: string;
}

export interface RegisterAgentOpts {
  apiKey: string;
  metadata?: AgentMetadata;
  name: string;
  wallet?: AgentWalletInput;
}

export interface ResolveAgentOpts {
  apiKey: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Response types (§7.9).
// ---------------------------------------------------------------------------

export interface RecordAck {
  is_duplicate: boolean;
  record_id: string;
  server_ts_utc: number;
  session_id: string;
}

export interface RecordError {
  code: string;
  message: string;
  record_id: string;
}

export interface BatchAck {
  batch_id: string;
  results: (RecordAck | RecordError)[];
}

export interface SessionFetch {
  records: Record<string, unknown>[];
  session_id: string;
}

export interface TracePage {
  next_cursor: string | null;
  records: Record<string, unknown>[];
}

export interface AgentRegistration {
  agent_id: string;
  agent_wallet_address: string;
  created_at: number;
  name: string;
}

// ---------------------------------------------------------------------------
// GetTrace options.
// ---------------------------------------------------------------------------

export interface GetTraceOpts {
  /** record_id cursor; returns records older than this record. */
  before?: string;
  /** Page size. Default 100, max 500. */
  limit?: number;
}
