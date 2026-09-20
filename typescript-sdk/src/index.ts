// ---------------------------------------------------------------------------
// Public surface of the Reasoning Ledger TypeScript SDK.
// ---------------------------------------------------------------------------

// Core classes
export { LedgerClient } from "./client.js";
export { Session } from "./session.js";

// Error hierarchy
export {
  AuthError,
  IdempotencyConflictError,
  LedgerError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from "./errors.js";

// Utility helpers (§7.7)
export { isValidRecordId, newRecordId, nowEpochMs } from "./utils.js";

// Constants
export { SCHEMA_VERSION, SIZE_LIMITS } from "./constants.js";

// HTTP transport (for custom instrumentation / test injection)
export { FetchTransport } from "./http.js";

// Configuration, input, record and response types
export type {
  ActingRecord,
  AgentMetadata,
  AgentRegistration,
  AgentWalletInput,
  AttestingInput,
  AttestingRecord,
  BatchAck,
  ContentInput,
  ContentInputEntry,
  GetTraceOpts,
  HttpRequest,
  HttpResponse,
  HttpTransport,
  LedgerClientConfig,
  LedgerRecord,
  MakeOptional,
  ModelInvocationInput,
  RecordAck,
  RecordError,
  RegisterAgentOpts,
  ResolveAgentOpts,
  RetryConfig,
  SessionAttestingInput,
  SessionFetch,
  SessionSubmitInput,
  StoredRecord,
  SubmitInput,
  TracePage,
} from "./types.js";

// Record types from codegen (re-exported for partner use)
export type {
  BaseRecord,
  BehaviorType,
  ContentRef,
  EpochMs,
  Executor,
  ModelInvocation,
  ObservingRecord,
  OtherRecord,
  Outcome,
  PlanningRecord,
  PlanningStep,
  RecordPhase,
  ReflectingInput,
  ReflectingRecord,
  SourceDescriptor,
  ThinkingInput,
  ThinkingRecord,
  ToolCallingRecord,
  UuidV4,
  Verdict,
  WrittenBy,
} from "./generated/records.js";
