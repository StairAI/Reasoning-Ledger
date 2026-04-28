import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgent } from "#/routes/agents";
import { submitRecord } from "#/routes/records";
import { getTrace } from "#/routes/traces";
import { ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

describe("Traces — getTrace", () => {
  let owner: TestOwner;
  let ownerB: TestOwner;
  let agentId: string;

  // Submit 5 records so we have enough data for pagination tests.
  const submittedIds: string[] = [];

  beforeAll(async () => {
    [owner, ownerB] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    const reg = await call(
      registerAgent,
      { name: `trace-agent-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = reg.agent_id;

    for (let i = 0; i < 5; i += 1) {
      const input = makeObservingInput(agentId);
      await call(submitRecord, input, ctx(owner.apiKey));
      submittedIds.push(input.record_id);
    }
  });

  afterAll(async () => {
    await Promise.all([owner.cleanup(), ownerB.cleanup()]);
  });

  it("returns all records newest-first by default", async () => {
    const { records, next_cursor } = await call(getTrace, { agent_id: agentId }, ctx(owner.apiKey));

    expect(records.length).toBeGreaterThanOrEqual(5);
    expect(next_cursor).toBeNull();

    // Descending order check.
    for (let i = 1; i < records.length; i += 1) {
      expect(Number(records[i].server_ts_utc)).toBeLessThanOrEqual(
        Number(records[i - 1].server_ts_utc),
      );
    }

    for (const r of records) {
      expect(r.agent_id).toBe(agentId);
    }
  });

  it("respects the limit parameter", async () => {
    const { records } = await call(getTrace, { agent_id: agentId, limit: 2 }, ctx(owner.apiKey));

    expect(records).toHaveLength(2);
  });

  it("paginates via next_cursor / before", async () => {
    const page1 = await call(getTrace, { agent_id: agentId, limit: 2 }, ctx(owner.apiKey));

    expect(page1.records).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await call(
      getTrace,
      { agent_id: agentId, before: page1.next_cursor ?? undefined, limit: 2 },
      ctx(owner.apiKey),
    );

    // Pages must not overlap.
    const page1Ids = new Set(page1.records.map((r) => r.record_id));
    for (const r of page2.records) {
      expect(page1Ids.has(r.record_id as string)).toBeFalsy();
    }
  });

  it("returns next_cursor: null on the last page", async () => {
    // Use a very large limit so all records fit on one page.
    const { next_cursor } = await call(
      getTrace,
      { agent_id: agentId, limit: 500 },
      ctx(owner.apiKey),
    );

    expect(next_cursor).toBeNull();
  });

  it("returns BAD_REQUEST for an invalid cursor record_id", async () => {
    await expect(
      call(getTrace, { agent_id: agentId, before: crypto.randomUUID() }, ctx(owner.apiKey)),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns NOT_FOUND when the agent belongs to a different owner", async () => {
    await expect(call(getTrace, { agent_id: agentId }, ctx(ownerB.apiKey))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("returns NOT_FOUND for an unknown agent_id", async () => {
    await expect(
      call(getTrace, { agent_id: crypto.randomUUID() }, ctx(owner.apiKey)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns an empty records array for an agent with no records", async () => {
    const emptyReg = await call(
      registerAgent,
      { name: `empty-trace-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );

    const { records, next_cursor } = await call(
      getTrace,
      { agent_id: emptyReg.agent_id },
      ctx(owner.apiKey),
    );

    expect(records).toStrictEqual([]);
    expect(next_cursor).toBeNull();
  });

  it("rejects unauthenticated requests", async () => {
    await expect(call(getTrace, { agent_id: agentId }, ctx())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
