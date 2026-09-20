import type {
  ActingRecord,
  AttestingRecord,
  BehaviorType,
  ContentRef,
  Executor,
  ModelInvocation,
  ObservingRecord,
  OtherRecord,
  Outcome,
  PlanningRecord,
  RecordPhase,
  ReflectingRecord,
  ThinkingRecord,
  ToolCallingRecord,
} from "./generated/records.js";

// ---------------------------------------------------------------------------
// Record types (schema 0.4). The schema's cross-field (if/then) rules are not
// part of the generated types; validate.ts enforces them.
// ---------------------------------------------------------------------------

export type { ActingRecord, AttestingRecord };

/** A complete record of any behaviour, as the server accepts it. */
export type LedgerRecord =
  | ObservingRecord
  | ToolCallingRecord
  | PlanningRecord
  | ThinkingRecord
  | ActingRecord
  | ReflectingRecord
  | AttestingRecord
  | OtherRecord;

// ---------------------------------------------------------------------------
// Content inputs — raw content accepted at content positions.
// ---------------------------------------------------------------------------

/**
 * What a content position accepts in `submit`, `submitBatch`,
 * `submitAttesting` and their Session counterparts. A ContentRef is sent as
 * is. Anything else is raw content: the SDK uploads it first and puts the
 * returned ContentRef in its place — a string as `text/plain; charset=utf-8`,
 * a Uint8Array as `application/octet-stream`, and any other JSON value
 * (object, array, number, boolean, null) JSON-encoded as `application/json`.
 * A value counts as a ContentRef only if its keys are exactly `sha256`,
 * `bytes` and `media_type`.
 */
export type ContentInput = ContentRef | string | Uint8Array | number | boolean | object | null;

/** ModelInvocation as submitted: `internal_reasoning` may be raw content. */
export interface ModelInvocationInput extends Omit<ModelInvocation, "internal_reasoning"> {
  internal_reasoning?: ContentInput;
}

/** An entry of `Thinking.inputs` / `Reflecting.inputs` as submitted. */
export interface ContentInputEntry {
  input_payload: ContentInput;
  input_record_id?: string;
}

/** `R` with the keys of `Changes` retyped. */
type Retype<R, Changes> = Omit<R, keyof Changes> & Changes;

interface CommonInput {
  model_invocation?: ModelInvocationInput;
}

/** A complete record as submitted: content positions may hold raw content. */
type RecordInput =
  | Retype<ObservingRecord, CommonInput>
  | Retype<
      ToolCallingRecord,
      CommonInput & { input_payload: ContentInput; output_payload: ContentInput }
    >
  | Retype<PlanningRecord, CommonInput>
  | Retype<
      ThinkingRecord,
      CommonInput & {
        inputs: ContentInputEntry[];
        output_payload: ContentInput;
        prompt: ContentInput;
      }
    >
  | Retype<ActingRecord, CommonInput>
  | Retype<
      ReflectingRecord,
      CommonInput & { inputs: ContentInputEntry[]; output_payload: ContentInput }
    >
  | Retype<AttestingRecord, CommonInput & { effects?: ContentInput }>
  | Retype<OtherRecord, CommonInput>;

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
// SubmitInput — a record with auto-filled fields optional and raw content
// allowed at content positions. Callers still supply session_id (unless using
// Session), executor and record_phase.
// ---------------------------------------------------------------------------

export type SubmitInput = MakeOptional<RecordInput, AutoFilled>;

// ---------------------------------------------------------------------------
// SessionSubmitInput — additionally makes session_id optional (Session injects it).
// ---------------------------------------------------------------------------

export type SessionSubmitInput = MakeOptional<RecordInput, AutoFilled | "session_id">;

// ---------------------------------------------------------------------------
// AttestingInput — input of submitAttesting. The SDK sets behavior
// `Attesting` and executor `human`, and record_phase `concurrent` unless given.
// ---------------------------------------------------------------------------

type AttestingFields = Omit<
  Extract<RecordInput, { behavior: "Attesting" }>,
  "behavior" | "executor"
>;

export type AttestingInput = MakeOptional<AttestingFields, AutoFilled | "record_phase">;

export type SessionAttestingInput = MakeOptional<
  AttestingFields,
  AutoFilled | "record_phase" | "session_id"
>;

// ---------------------------------------------------------------------------
// HTTP transport abstraction — used for testing and custom instrumentation.
// ---------------------------------------------------------------------------

export interface HttpRequest {
  /** JSON text for API calls; raw bytes for content uploads. */
  body?: string | Uint8Array;
  headers: Record<string, string>;
  method: string;
  url: string;
}

export interface HttpResponse {
  /** The body decoded as UTF-8 text. */
  body: string;
  /**
   * The body as raw bytes. FetchTransport always fills it. A custom transport
   * may leave it out; `getContent` then falls back to the UTF-8 encoding of
   * `body`, which only round-trips text.
   */
  bodyBytes?: Uint8Array;
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
  defaultModelInvocation?: ModelInvocation;
  /**
   * Base URL of the Reasoning Ledger API, e.g. "https://stg-api.stair-ai.com".
   * Required; a trailing slash is ignored.
   */
  endpoint: string;
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
  /** Base URL of the Reasoning Ledger API, as in LedgerClientConfig. Required. */
  endpoint: string;
  metadata?: AgentMetadata;
  name: string;
  wallet?: AgentWalletInput;
}

export interface ResolveAgentOpts {
  apiKey: string;
  /** Base URL of the Reasoning Ledger API, as in LedgerClientConfig. Required. */
  endpoint: string;
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

/**
 * A record as the server returns it: the submitted fields plus the
 * server-assigned `server_ts_utc` and `sequence`. Records written with a
 * schema version before 0.4 carry no executor, record_phase, outcome or
 * duration_ms.
 */
export interface StoredRecord {
  [key: string]: unknown;
  agent_id: string;
  behavior: BehaviorType;
  client_ts_utc: number;
  duration_ms?: number;
  executor?: Executor;
  outcome?: Outcome;
  record_id: string;
  record_phase?: RecordPhase;
  schema_version: string;
  /** Server-assigned position in the total order of all records, ascending as received. */
  sequence: number;
  server_ts_utc: number;
  session_id: string;
  tags: string[];
  upstream_record_id: string[];
}

export interface SessionFetch {
  /** Every record of the session, in the order the server received them (`sequence` ascending). */
  records: StoredRecord[];
  session_id: string;
}

export interface TracePage {
  /** Pass as `before` to fetch the next (older) page; null on the last page. */
  next_cursor: string | null;
  /** Newest first (`sequence` descending). */
  records: StoredRecord[];
}

export interface AgentRegistration {
  agent_id: string;
  /** Null when a bring-your-own-wallet owner has no default wallet address. */
  agent_wallet_address: string | null;
  created_at: number;
  name: string;
}

// ---------------------------------------------------------------------------
// GetTrace options.
// ---------------------------------------------------------------------------

export interface GetTraceOpts {
  /**
   * `next_cursor` from the previous page: an opaque string (today a decimal
   * sequence number, not a record id). Returns the records before it.
   */
  before?: string;
  /** Page size. Default 100, max 500. */
  limit?: number;
}
