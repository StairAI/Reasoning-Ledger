import type { LedgerClient } from "./client.js";
import type { BatchAck, RecordAck, SessionSubmitInput } from "./types.js";
import { newRecordId } from "./utils.js";

// ---------------------------------------------------------------------------
// Session
//
// A lightweight wrapper that binds a session_id to a LedgerClient, so
// callers don't have to pass it on every record. Purely client-side sugar;
// no server-side session lifecycle exists.
// ---------------------------------------------------------------------------

export class Session {
  /** The bound session_id. Read-only. */
  readonly id: string;

  private readonly client: LedgerClient;

  constructor(client: LedgerClient, sessionId?: string) {
    this.client = client;
    this.id = sessionId ?? newRecordId();
  }

  /**
   * Submit a single record, auto-injecting `session_id = this.id`.
   * All other auto-fill rules (agent_id, record_id, schema_version,
   * client_ts_utc) apply as on LedgerClient.submit.
   */
  submit(input: SessionSubmitInput): Promise<RecordAck> {
    return this.client._submit({ ...input, session_id: this.id });
  }

  /**
   * Submit a batch of records, auto-injecting `session_id = this.id`
   * on each record. All other auto-fill rules apply per record.
   */
  submitBatch(inputs: SessionSubmitInput[]): Promise<BatchAck> {
    return this.client._submitBatch(inputs.map((input) => ({ ...input, session_id: this.id })));
  }
}
