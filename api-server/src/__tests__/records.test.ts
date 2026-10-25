import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, expectTypeOf } from "vitest";
import { registerAgent } from "#/routes/agents";
import { getRecord, submitBatch, submitRecord } from "#/routes/records";
import { prisma } from "#/lib/prisma";
import { SCHEMA_VERSION } from "#/generated/version";
import { call, ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
        message: expect.stringContaining(`upgrade to an SDK that writes ${SCHEMA_VERSION}`),
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

    it("accepts a valid upstream_record_id reference", async () => {
      const upstream = makeObservingInput(agentId);
      await call(submitRecord, upstream, ctx(owner.apiKey));

      const child = makeObservingInput(agentId, { upstream_record_id: [upstream.record_id] });
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
  // Fixtures for behaviours other than Observing
  // -------------------------------------------------------------------------

  const writtenBy = { component: "test-harness", credential: "owner-key" };

  function attesting(overrides: Record<string, unknown> = {}) {
    return {
      ...makeObservingInput(agentId),
      behavior: "Attesting" as const,
      disposition: "approve" as const,
      executor: "human" as const,
      gate_kind: "approval",
      operator_id: "reviewer-1",
      outcome: "success" as const,
      record_phase: "concurrent" as const,
      trigger_description: undefined,
      trigger_payload_summary: undefined,
      trigger_source: undefined,
      trigger_type: undefined,
      written_by: writtenBy,
      ...overrides,
    };
  }

  function acting(overrides: Record<string, unknown> = {}) {
    return {
      ...makeObservingInput(agentId),
      action_summary: "publish",
      action_type: "chain.publish",
      behavior: "Acting" as const,
      execution_status: "confirmed" as const,
      executor: "ai" as const,
      outcome: "success" as const,
      target_system: "public-chain",
      trigger_description: undefined,
      trigger_payload_summary: undefined,
      trigger_source: undefined,
      trigger_type: undefined,
      ...overrides,
    };
  }

  /** A reference to content this owner has uploaded: the row an upload leaves behind. */
  async function uploaded(text: string) {
    const ref = { bytes: Buffer.byteLength(text), media_type: "text/plain", sha256: sha(text) };
    await prisma.contentObject.upsert({
      create: { ...ref, owner_id: owner.ownerId },
      update: {},
      where: { owner_id_sha256: { owner_id: owner.ownerId, sha256: ref.sha256 } },
    });
    return ref;
  }

  /** A well-formed reference to content nobody uploaded. */
  function notUploaded() {
    return { bytes: 1, media_type: "text/plain", sha256: sha(crypto.randomUUID()) };
  }

  function escalating(overrides: Record<string, unknown> = {}) {
    return {
      ...makeObservingInput(agentId),
      asked: notUploaded(),
      behavior: "Escalating" as const,
      executor: "ai" as const,
      kind: "question" as const,
      outcome: "success" as const,
      record_phase: "concurrent" as const,
      trigger_description: undefined,
      trigger_payload_summary: undefined,
      trigger_source: undefined,
      trigger_type: undefined,
      ...overrides,
    };
  }

  function delegating(overrides: Record<string, unknown> = {}) {
    return {
      ...makeObservingInput(agentId),
      behavior: "Delegating" as const,
      executor: "ai" as const,
      goal: notUploaded(),
      kind: "spawn" as const,
      outcome: "success" as const,
      record_phase: "post_execution" as const,
      trigger_description: undefined,
      trigger_payload_summary: undefined,
      trigger_source: undefined,
      trigger_type: undefined,
      ...overrides,
    };
  }

  function memorizing(overrides: Record<string, unknown> = {}) {
    return {
      ...makeObservingInput(agentId),
      behavior: "Memorizing" as const,
      executor: "ai" as const,
      op: "add" as const,
      outcome: "success" as const,
      record_phase: "post_execution" as const,
      scope: "project" as const,
      target: notUploaded(),
      trigger_description: undefined,
      trigger_payload_summary: undefined,
      trigger_source: undefined,
      trigger_type: undefined,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Schema 0.4
  // -------------------------------------------------------------------------

  describe("schema 0.4", () => {
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
        schema_version: SCHEMA_VERSION,
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
      await expect(call(submitRecord, acting(), ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("execution_id is required"),
      });
      const ack = await call(submitRecord, acting({ execution_id: "0xabc" }), ctx(owner.apiKey));
      expect(ack.is_duplicate).toBeFalsy();
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

  // -------------------------------------------------------------------------
  // Schema 0.5
  // -------------------------------------------------------------------------

  describe("schema 0.5", () => {
    it("rejects writes stamped 0.4, which stay readable only", async () => {
      const input = makeObservingInput(agentId, { schema_version: "0.4" });
      await expect(call(submitRecord, input, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining(
          `'0.4' is readable but no longer accepted for writes; upgrade to an SDK that writes ${SCHEMA_VERSION}`,
        ),
      });
    });

    it("accepts a Planning record, and keeps a plan's steps off Thinking", async () => {
      const revised = crypto.randomUUID();
      const planning = {
        ...makeObservingInput(agentId),
        behavior: "Planning" as const,
        contingencies: ["roll back"],
        executor: "ai" as const,
        goal: "ship the fix",
        revision_of: revised,
        steps: [{ description: "run the tests", index: 0 }],
        trigger_description: undefined,
        trigger_payload_summary: undefined,
        trigger_source: undefined,
        trigger_type: undefined,
      };
      const ack = await call(submitRecord, planning, ctx(owner.apiKey));
      expect(ack.is_duplicate).toBeFalsy();
      const stored = await call(getRecord, { record_id: planning.record_id }, ctx(owner.apiKey));
      expect(stored).toMatchObject({
        behavior: "Planning",
        contingencies: ["roll back"],
        goal: "ship the fix",
        revision_of: revised,
        steps: [{ description: "run the tests", index: 0 }],
      });
      const thinking = {
        ...planning,
        behavior: "Thinking" as const,
        contingencies: undefined,
        goal: undefined,
        output_payload: await uploaded("plan: run the tests"),
        record_id: crypto.randomUUID(),
        revision_of: undefined,
      };
      // Deliberately invalid: cast past the input type.
      await expect(call(submitRecord, thinking as never, ctx(owner.apiKey))).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("accepts an Escalating record and the Attesting record that answers it", async () => {
      const question = escalating({
        asked: await uploaded("Deploy to production now?"),
        default: "no",
        duration_ms: 42_000,
        options: ["yes", "no"],
      });
      await call(submitRecord, question, ctx(owner.apiKey));
      const answer = attesting({
        channel: "interactive",
        decision: "yes",
        gate_kind: "question",
        seen_completeness: "complete",
        upstream_record_id: [question.record_id],
      });
      await call(submitRecord, answer, ctx(owner.apiKey));

      const stored = await call(getRecord, { record_id: question.record_id }, ctx(owner.apiKey));
      expect(stored).toMatchObject({
        asked: question.asked,
        behavior: "Escalating",
        default: "no",
        duration_ms: 42_000,
        kind: "question",
        options: ["yes", "no"],
        outcome: "success",
      });
      const disposition = await call(getRecord, { record_id: answer.record_id }, ctx(owner.apiKey));
      expect(disposition).toMatchObject({
        channel: "interactive",
        seen_completeness: "complete",
        upstream_record_id: [question.record_id],
      });
    });

    it("accepts a Delegating record", async () => {
      const result = await uploaded("Two issues found");
      const input = delegating({
        awaited: true,
        child_session_id: "child-session",
        delegate_agent_id: "code-reviewer",
        goal: await uploaded("Review the diff"),
        result,
      });
      await call(submitRecord, input, ctx(owner.apiKey));
      const stored = await call(getRecord, { record_id: input.record_id }, ctx(owner.apiKey));
      expect(stored).toMatchObject({
        awaited: true,
        behavior: "Delegating",
        child_session_id: "child-session",
        delegate_agent_id: "code-reviewer",
        goal: input.goal,
        kind: "spawn",
        outcome: "success",
        result,
      });
    });

    it("accepts a Memorizing record approved by a person", async () => {
      const approval = attesting({ gate_kind: "permission" });
      await call(submitRecord, approval, ctx(owner.apiKey));
      const input = memorizing({
        approved_by: approval.record_id,
        op: "update",
        target: await uploaded("Always run the linter before committing."),
      });
      await call(submitRecord, input, ctx(owner.apiKey));
      const stored = await call(getRecord, { record_id: input.record_id }, ctx(owner.apiKey));
      expect(stored).toMatchObject({
        approved_by: approval.record_id,
        behavior: "Memorizing",
        op: "update",
        outcome: "success",
        scope: "project",
        target: input.target,
      });
    });

    it("requires an outcome on Acting, Attesting, Escalating, Delegating and Memorizing", async () => {
      const records = [acting(), attesting(), escalating(), delegating(), memorizing()];
      for (const record of records) {
        // Deliberately invalid: cast past the input type.
        const input = { ...record, outcome: undefined } as never;
        await expect(call(submitRecord, input, ctx(owner.apiKey))).rejects.toMatchObject({
          code: "BAD_REQUEST",
        });
      }
    });

    it("requires a namespaced action_type and accepts a cancelled Acting record", async () => {
      await expect(
        call(submitRecord, acting({ action_type: "publish" }), ctx(owner.apiKey)),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      const ack = await call(
        submitRecord,
        acting({
          action_type: "answer.final",
          execution_status: "cancelled",
          outcome: "cancelled",
          target_system: "chat",
        }),
        ctx(owner.apiKey),
      );
      expect(ack.is_duplicate).toBeFalsy();
    });

    it("requires outcome timeout when nobody answered and cancelled when the person cancelled", async () => {
      await expect(
        call(
          submitRecord,
          attesting({ channel: "headless", disposition: "no_response" }),
          ctx(owner.apiKey),
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining(
          "outcome must be 'timeout' when disposition is 'no_response'",
        ),
      });
      await expect(
        call(submitRecord, attesting({ disposition: "cancel" }), ctx(owner.apiKey)),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining(
          "outcome must be 'cancelled' when disposition is 'cancel'",
        ),
      });

      const { results } = await call(
        submitBatch,
        {
          records: [
            attesting({ channel: "headless", disposition: "no_response", outcome: "timeout" }),
            attesting({ disposition: "cancel", outcome: "cancelled" }),
            attesting({ disposition: "cancel", outcome: "timeout" }),
          ],
        },
        ctx(owner.apiKey),
      );
      expect(results[0]).toMatchObject({ is_duplicate: false });
      expect(results[1]).toMatchObject({ is_duplicate: false });
      expect(results[2]).toMatchObject({
        code: "validation_failed",
        message: expect.stringContaining("outcome must be 'cancelled'"),
      });
    });

    it("checks content referenced at the positions 0.5 added", async () => {
      const present = await uploaded("an uploaded goal");
      const records = [
        escalating(),
        delegating(),
        delegating({ goal: present, result: notUploaded() }),
        memorizing(),
        delegating({
          goal: present,
          model_invocation: {
            invocation_kind: "replay",
            model_name: null,
            provider: null,
            replay_of: notUploaded(),
          },
        }),
      ];
      for (const record of records) {
        await expect(call(submitRecord, record, ctx(owner.apiKey))).rejects.toMatchObject({
          code: "BAD_REQUEST",
          message: expect.stringContaining("has not been uploaded"),
        });
      }
    });

    it("stores the 0.5 base fields with the record and reads them back", async () => {
      const classification = {
        alternatives: [{ behavior: "ToolCalling" as const, confidence: 0.2 }],
        confidence: 0.8,
        mapper: "test-mapper@1",
        source: "rule" as const,
      };
      const modelInvocation = {
        cache_creation_tokens: 5,
        cache_read_tokens: 1200,
        invocation_kind: "replay" as const,
        model_name: null,
        provider: null,
        replay_of: crypto.randomUUID(),
        request_id: "req_123",
      };
      const onBehalfOf = crypto.randomUUID();
      const input = memorizing({
        classification,
        error_type: "permission.denied",
        model_invocation: modelInvocation,
        on_behalf_of_agent_id: onBehalfOf,
        outcome: "denied",
        target: await uploaded("a memory the platform refused"),
        written_by: writtenBy,
      });
      await call(submitRecord, input, ctx(owner.apiKey));
      const stored = await call(getRecord, { record_id: input.record_id }, ctx(owner.apiKey));
      expect(stored).toMatchObject({
        classification,
        error_type: "permission.denied",
        model_invocation: modelInvocation,
        on_behalf_of_agent_id: onBehalfOf,
        outcome: "denied",
        schema_version: SCHEMA_VERSION,
        written_by: writtenBy,
      });
    });

    it("keeps 0.4 records readable, with the fields 0.5 removed", async () => {
      const parent = makeObservingInput(agentId);
      await call(submitRecord, parent, ctx(owner.apiKey));
      const recordId = crypto.randomUUID();
      await prisma.traceRecord.create({
        data: {
          agent_id: agentId,
          behavior: "Planning",
          client_ts_utc: BigInt(Date.now()),
          executor: "ai",
          model_invocation: { model_name: "m", model_version: "2026-01", provider: "p" },
          parent_record_id: parent.record_id,
          payload: {
            contingencies: ["roll back"],
            goal: "ship the fix",
            steps: [{ description: "run the tests", index: 0 }],
          },
          record_id: recordId,
          record_phase: "pre_execution",
          schema_version: "0.4",
          server_ts_utc: BigInt(Date.now()),
          session_id: "legacy-0.4-session",
        },
      });
      const stored = await call(getRecord, { record_id: recordId }, ctx(owner.apiKey));
      expect(stored).toMatchObject({
        behavior: "Planning",
        contingencies: ["roll back"],
        goal: "ship the fix",
        model_invocation: { model_version: "2026-01" },
        parent_record_id: parent.record_id,
        schema_version: "0.4",
        steps: [{ description: "run the tests", index: 0 }],
      });
    });

    it("refuses a current-version row without executor at the database level", async () => {
      await expect(
        prisma.traceRecord.create({
          data: {
            agent_id: agentId,
            behavior: "Escalating",
            client_ts_utc: BigInt(Date.now()),
            payload: {},
            record_id: crypto.randomUUID(),
            schema_version: SCHEMA_VERSION,
            server_ts_utc: BigInt(Date.now()),
            session_id: "no-executor",
          },
        }),
      ).rejects.toThrow(/trace_records_executor_phase_check/);
    });
  });
});
