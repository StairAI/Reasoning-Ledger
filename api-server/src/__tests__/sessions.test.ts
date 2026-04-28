import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgent } from "#/routes/agents";
import { submitRecord } from "#/routes/records";
import { getSession } from "#/routes/sessions";
import { ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

describe("Sessions — getSession", () => {
  let owner: TestOwner;
  let ownerB: TestOwner;
  let agentId: string;
  const sessionId = `sess-${crypto.randomUUID()}`;

  beforeAll(async () => {
    [owner, ownerB] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    const reg = await call(
      registerAgent,
      { name: `sess-agent-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = reg.agent_id;

    // Submit two records in the same session.
    await call(
      submitRecord,
      makeObservingInput(agentId, { session_id: sessionId }),
      ctx(owner.apiKey),
    );
    await call(
      submitRecord,
      makeObservingInput(agentId, { session_id: sessionId }),
      ctx(owner.apiKey),
    );
  });

  afterAll(async () => {
    await Promise.all([owner.cleanup(), ownerB.cleanup()]);
  });

  it("returns all records in the session ordered by server_ts_utc asc", async () => {
    const { records, session_id } = await call(
      getSession,
      { agent_id: agentId, session_id: sessionId },
      ctx(owner.apiKey),
    );

    expect(session_id).toBe(sessionId);
    expect(records.length).toBeGreaterThanOrEqual(2);

    // Ascending order check.
    for (let i = 1; i < records.length; i += 1) {
      expect(Number(records[i].server_ts_utc)).toBeGreaterThanOrEqual(
        Number(records[i - 1].server_ts_utc),
      );
    }

    // Each record has the expected base fields.
    for (const r of records) {
      expect(r.agent_id).toBe(agentId);
      expect(r.session_id).toBe(sessionId);
      expect(r.behavior).toBe("Observing");
    }
  });

  it("returns an empty records array for a session with no records", async () => {
    const { records } = await call(
      getSession,
      { agent_id: agentId, session_id: `empty-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );

    expect(records).toStrictEqual([]);
  });

  it("returns NOT_FOUND when the agent belongs to a different owner", async () => {
    await expect(
      call(getSession, { agent_id: agentId, session_id: sessionId }, ctx(ownerB.apiKey)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns NOT_FOUND for an unknown agent_id", async () => {
    await expect(
      call(getSession, { agent_id: crypto.randomUUID(), session_id: sessionId }, ctx(owner.apiKey)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects unauthenticated requests", async () => {
    await expect(
      call(getSession, { agent_id: agentId, session_id: sessionId }, ctx()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
