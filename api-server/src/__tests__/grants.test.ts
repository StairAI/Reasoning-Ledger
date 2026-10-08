import { call } from "@orpc/server";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgent } from "#/routes/agents";
import { submitRecord } from "#/routes/records";
import { ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

// Set by scripts/test-local.mts: the runtime account, with prisma/grants.sql applied.
const runtimeUrl = process.env.RL_TEST_RUNTIME_URL;

describe.skipIf(!runtimeUrl)("runtime database account", () => {
  let owner: TestOwner;
  let agentId: string;
  let recordId: string;
  let runtime: Client;

  beforeAll(async () => {
    owner = await makeTestOwner();
    const reg = await call(
      registerAgent,
      { name: `grants-agent-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = reg.agent_id;
    const input = makeObservingInput(agentId);
    await call(submitRecord, input, ctx(owner.apiKey));
    recordId = input.record_id;
    runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime.end();
    await owner.cleanup();
  });

  it("reads and appends records", async () => {
    const read = await runtime.query("SELECT record_id FROM trace_records WHERE record_id = $1", [
      recordId,
    ]);
    expect(read.rowCount).toBe(1);

    const appended = await runtime.query(
      `INSERT INTO trace_records (record_id, agent_id, session_id, schema_version, behavior,
         client_ts_utc, server_ts_utc, tags, upstream_record_id, payload, executor, record_phase)
       VALUES ($1, $2, 's', '0.4', 'Observing', 1, 1, '{}', '{}', '{}', 'det', 'post_execution')`,
      [crypto.randomUUID(), agentId],
    );
    expect(appended.rowCount).toBe(1);
  });

  it("can never update or delete records", async () => {
    await expect(
      runtime.query("UPDATE trace_records SET notes = 'changed' WHERE record_id = $1", [recordId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runtime.query("DELETE FROM trace_records WHERE record_id = $1", [recordId]),
    ).rejects.toThrow(/permission denied/);
  });

  it("issues, spends and clears viewer sign-in tickets", async () => {
    const id = "f".repeat(64);
    const issued = await runtime.query(
      `INSERT INTO viewer_tickets (id, owner_id, next, expires_at)
       VALUES ($1, $2, '/', now() + interval '1 minute')`,
      [id, owner.ownerId],
    );
    expect(issued.rowCount).toBe(1);
    const spent = await runtime.query(
      `UPDATE viewer_tickets SET used_at = now()
       WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING owner_id`,
      [id],
    );
    expect(spent.rows).toStrictEqual([{ owner_id: owner.ownerId }]);
    const cleared = await runtime.query("DELETE FROM viewer_tickets WHERE id = $1", [id]);
    expect(cleared.rowCount).toBe(1);
  });

  it("cannot write the content deletion log or read the migration history", async () => {
    await expect(
      runtime.query(
        "INSERT INTO content_deletions (id, owner_id, sha256, reason, operator) VALUES ('x', 'o', 's', 'r', 'op')",
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(runtime.query("SELECT * FROM _prisma_migrations")).rejects.toThrow(
      /permission denied/,
    );
  });
});
