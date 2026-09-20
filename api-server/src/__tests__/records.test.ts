import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it, expectTypeOf } from "vitest";
import { registerAgent } from "#/routes/agents";
import { getRecord, submitBatch, submitRecord } from "#/routes/records";
import { prisma } from "#/lib/prisma";
import { ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

describe("Records", () => {
  let owner: TestOwner;
  let ownerB: TestOwner;
  let agentId: string;

  beforeAll(async () => {
    [owner, ownerB] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    const reg = await call(
      registerAgent,
      { name: `rec-agent-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = reg.agent_id;
  });

  afterAll(async () => {
    await Promise.all([owner.cleanup(), ownerB.cleanup()]);
  });

  // -------------------------------------------------------------------------
  // POST /v1/records — submitRecord
  // -------------------------------------------------------------------------

  describe("POST /v1/records — submitRecord", () => {
    it("accepts a valid Observing record and returns a RecordAck", async () => {
      const input = makeObservingInput(agentId);
      const ack = await call(submitRecord, input, ctx(owner.apiKey));

      expect(ack.record_id).toBe(input.record_id);
      expect(ack.session_id).toBe(input.session_id);
      expectTypeOf(ack.server_ts_utc).toBeNumber();
      expect(ack.is_duplicate).toBeFalsy();
    });

    it("is idempotent — re-submitting same record_id returns is_duplicate: true", async () => {
      const input = makeObservingInput(agentId);
      const first = await call(submitRecord, input, ctx(owner.apiKey));
      const second = await call(submitRecord, input, ctx(owner.apiKey));

      expect(second.is_duplicate).toBeTruthy();
      expect(second.record_id).toBe(first.record_id);
      expect(second.server_ts_utc).toBe(first.server_ts_utc);
    });

    it("rejects an unsupported schema_version", async () => {
      const input = makeObservingInput(agentId, { schema_version: "99.9" });
      await expect(call(submitRecord, input, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("Unsupported schema_version '99.9'"),
      });
    });

    it("rejects writes stamped with an older schema_version, which stays readable only", async () => {
      const input = makeObservingInput(agentId, { schema_version: "0.3" });
      await expect(call(submitRecord, input, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("readable but no longer accepted for writes"),
      });
    });

    it("rejects the retired '1.0' label with an upgrade hint", async () => {
      const input = makeObservingInput(agentId, { schema_version: "1.0" });
      await expect(call(submitRecord, input, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("upgrade to an SDK that writes 0.4"),
      });
    });

    it("checks the version before the record shape, so an old-format body gets the upgrade hint", async () => {
      const oldFormat = {
        ...makeObservingInput(agentId, { schema_version: "0.3" }),
        executor: undefined,
        record_phase: undefined,
      };
      // Deliberately not a valid 0.4 record: cast past the input type.
      await expect(call(submitRecord, oldFormat as never, ctx(owner.apiKey))).rejects.toMatchObject(
        {
          code: "BAD_REQUEST",
          message: expect.stringContaining("upgrade to an SDK"),
        },
      );
    });

    it("rejects a record for an agent owned by a different owner", async () => {
      const input = makeObservingInput(agentId); // agentId belongs to `owner`, not `ownerB`
      await expect(call(submitRecord, input, ctx(ownerB.apiKey))).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });

    it("rejects an invalid upstream_record_id reference", async () => {
      const input = makeObservingInput(agentId, {
        upstream_record_id: [crypto.randomUUID()], // does not exist
      });
      await expect(call(submitRecord, input, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("accepts valid upstream_record_id and parent_record_id references", async () => {
      const upstream = makeObservingInput(agentId);
      await call(submitRecord, upstream, ctx(owner.apiKey));

      const parent = makeObservingInput(agentId);
      await call(submitRecord, parent, ctx(owner.apiKey));

      const child = makeObservingInput(agentId, {
        parent_record_id: parent.record_id,
        upstream_record_id: [upstream.record_id],
      });
      const ack = await call(submitRecord, child, ctx(owner.apiKey));
      expect(ack.is_duplicate).toBeFalsy();
    });

    it("rejects unauthenticated requests", async () => {
      await expect(call(submitRecord, makeObservingInput(agentId), ctx())).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  // -------------------------------------------------------------------------
  // POST /v1/records/batch — submitBatch
  // -------------------------------------------------------------------------

  describe("POST /v1/records/batch — submitBatch", () => {
    it("persists multiple records and returns an ack for each", async () => {
      const records = [makeObservingInput(agentId), makeObservingInput(agentId)];
      const { batch_id, results } = await call(submitBatch, { records }, ctx(owner.apiKey));

      expect(batch_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result).toMatchObject({ is_duplicate: false });
      }
    });

    it("isolates per-record failures — valid records still succeed", async () => {
      const good = makeObservingInput(agentId);
      const bad = makeObservingInput(agentId, { upstream_record_id: [crypto.randomUUID()] });

      const { results } = await call(submitBatch, { records: [good, bad] }, ctx(owner.apiKey));

      expect(results[0]).toMatchObject({ is_duplicate: false });
      expect(results[1]).toMatchObject({ code: "validation_failed" });
    });

    it("deduplicates records within the same batch", async () => {
      const record = makeObservingInput(agentId);
      const { results } = await call(submitBatch, { records: [record, record] }, ctx(owner.apiKey));

      expect(results[0]).toMatchObject({ is_duplicate: false });
      expect(results[1]).toMatchObject({ is_duplicate: true });
    });

    it("rejects batches with 0 records", async () => {
      await expect(call(submitBatch, { records: [] }, ctx(owner.apiKey))).rejects.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/records/:record_id — getRecord
  // -------------------------------------------------------------------------

  describe("GET /v1/records/{record_id} — getRecord", () => {
    it("returns the full record with base + payload fields merged", async () => {
      const input = makeObservingInput(agentId, {
        notes: "test note",
        trigger_source: "unit-test",
      });
      await call(submitRecord, input, ctx(owner.apiKey));

      const record = await call(getRecord, { record_id: input.record_id }, ctx(owner.apiKey));

      expect(record.record_id).toBe(input.record_id);
      expect(record.agent_id).toBe(agentId);
      expect(record.behavior).toBe("Observing");
      expect(record.notes).toBe("test note");
      expect(record.server_ts_utc).toBeTypeOf("number");
      expect(record.client_ts_utc).toBeTypeOf("number");
    });

    it("returns NOT_FOUND for an unknown record_id", async () => {
      await expect(
        call(getRecord, { record_id: crypto.randomUUID() }, ctx(owner.apiKey)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns NOT_FOUND when a different owner tries to fetch the record", async () => {
      const input = makeObservingInput(agentId);
      await call(submitRecord, input, ctx(owner.apiKey));

      await expect(
        call(getRecord, { record_id: input.record_id }, ctx(ownerB.apiKey)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // -------------------------------------------------------------------------
  // Schema 0.4
  // -------------------------------------------------------------------------

  describe("schema 0.4", () => {
    const writtenBy = { component: "test-harness", credential: "owner-key" };

    function attesting(overrides: Record<string, unknown> = {}) {
      return {
        ...makeObservingInput(agentId),
        behavior: "Attesting" as const,
        disposition: "approve" as const,
        executor: "human" as const,
        gate_kind: "approval",
        operator_id: "reviewer-1",
        record_phase: "concurrent" as const,
        trigger_description: undefined,
        trigger_payload_summary: undefined,
        trigger_source: undefined,
        trigger_type: undefined,
        written_by: writtenBy,
        ...overrides,
      };
    }

    it("stores executor, record_phase, outcome and duration_ms and reads them back with a sequence", async () => {
      const first = makeObservingInput(agentId, { duration_ms: 12, outcome: "success" });
      const second = makeObservingInput(agentId);
      await call(submitRecord, first, ctx(owner.apiKey));
      await call(submitRecord, second, ctx(owner.apiKey));

      const a = await call(getRecord, { record_id: first.record_id }, ctx(owner.apiKey));
      const b = await call(getRecord, { record_id: second.record_id }, ctx(owner.apiKey));
      expect(a).toMatchObject({
        duration_ms: 12,
        executor: "det",
        outcome: "success",
        record_phase: "post_execution",
        schema_version: "0.4",
      });
      expect(b["outcome"]).toBeUndefined();
      expect(Number(b["sequence"])).toBeGreaterThan(Number(a["sequence"]));
    });

    it("requires executor and record_phase", async () => {
      const input = { ...makeObservingInput(agentId), executor: undefined };
      // Deliberately invalid: cast past the input type.
      await expect(call(submitRecord, input as never, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("accepts an Attesting record with decision, seen_digest and written_by", async () => {
      const input = attesting({ decision: { owner: "member-b" }, seen_digest: "sha256:abc" });
      await call(submitRecord, input, ctx(owner.apiKey));
      const stored = await call(getRecord, { record_id: input.record_id }, ctx(owner.apiKey));
      expect(stored).toMatchObject({
        behavior: "Attesting",
        decision: { owner: "member-b" },
        executor: "human",
        seen_digest: "sha256:abc",
        written_by: writtenBy,
      });
    });

    it("requires a reason when an Attesting record rejects", async () => {
      await expect(
        call(submitRecord, attesting({ disposition: "reject" }), ctx(owner.apiKey)),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("reason is required"),
      });
      const ack = await call(
        submitRecord,
        attesting({ disposition: "reject", reason: "wrong owner" }),
        ctx(owner.apiKey),
      );
      expect(ack.is_duplicate).toBeFalsy();
    });

    it("only accepts human as the executor of an Attesting record", async () => {
      await expect(
        call(submitRecord, attesting({ executor: "ai" }), ctx(owner.apiKey)),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("requires execution_id for a confirmed public-chain Acting record", async () => {
      const acting = {
        ...makeObservingInput(agentId),
        action_summary: "publish",
        action_type: "publish",
        behavior: "Acting" as const,
        dry_run: false,
        execution_status: "confirmed" as const,
        parameters: {},
        target_system: "public-chain",
        trigger_description: undefined,
        trigger_payload_summary: undefined,
        trigger_source: undefined,
        trigger_type: undefined,
      };
      await expect(call(submitRecord, acting, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("execution_id is required"),
      });
    });

    it("keeps records written before 0.4 readable", async () => {
      const recordId = crypto.randomUUID();
      await prisma.traceRecord.create({
        data: {
          agent_id: agentId,
          behavior: "Observing",
          client_ts_utc: BigInt(Date.now()),
          payload: { trigger_source: "legacy", trigger_type: "cron_trigger" },
          record_id: recordId,
          schema_version: "0.3",
          server_ts_utc: BigInt(Date.now()),
          session_id: "legacy-session",
        },
      });
      const stored = await call(getRecord, { record_id: recordId }, ctx(owner.apiKey));
      expect(stored).toMatchObject({ schema_version: "0.3", trigger_source: "legacy" });
      expect(stored["executor"]).toBeUndefined();
    });

    it("refuses a 0.4 row without executor at the database level", async () => {
      await expect(
        prisma.traceRecord.create({
          data: {
            agent_id: agentId,
            behavior: "Observing",
            client_ts_utc: BigInt(Date.now()),
            payload: {},
            record_id: crypto.randomUUID(),
            schema_version: "0.4",
            server_ts_utc: BigInt(Date.now()),
            session_id: "no-executor",
          },
        }),
      ).rejects.toThrow(/trace_records_executor_phase_check/);
    });
  });
});
