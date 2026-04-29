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
export { ENDPOINTS, SCHEMA_VERSION, SIZE_LIMITS } from "./constants.js";

// HTTP transport (for custom instrumentation / test injection)
export { FetchTransport } from "./http.js";

// Configuration and response types
export type {
  AgentMetadata,
  AgentRegistration,
  AgentWalletInput,
  BatchAck,
  GetTraceOpts,
  HttpRequest,
  HttpResponse,
  HttpTransport,
  LedgerClientConfig,
  MakeOptional,
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

// Record types from codegen (re-exported for partner use)
export type {
  ActingRecord,
  BaseRecord,
  BehaviorType,
  EpochMs,
  ModelInvocation,
  ObservingRecord,
  OtherRecord,
  PlanningRecord,
  PlanningStep,
  ReflectingInput,
  ReflectingRecord,
  ThinkingInput,
  ThinkingRecord,
  ToolCallingRecord,
  UuidV4,
} from "./generated/records.js";
