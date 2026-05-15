import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it, expectTypeOf } from "vitest";
import { registerAgent } from "#/routes/agents";
import { getRecord, submitBatch, submitRecord } from "#/routes/records";
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

  describe(submitRecord, () => {
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

    it("accepts a non-latest schema_version as record metadata", async () => {
      const input = makeObservingInput(agentId, { schema_version: "99.9" });
      const ack = await call(submitRecord, input, ctx(owner.apiKey));
      const stored = await call(getRecord, { record_id: input.record_id }, ctx(owner.apiKey));

      expect(ack.record_id).toBe(input.record_id);
      expect(stored["schema_version"]).toBe("99.9");
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
  // POST /v1/records:batch — submitBatch
  // -------------------------------------------------------------------------

  describe(submitBatch, () => {
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

  describe(getRecord, () => {
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
      expectTypeOf(record.server_ts_utc).toBeNumber();
      expectTypeOf(record.client_ts_utc).toBeNumber();
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
});
