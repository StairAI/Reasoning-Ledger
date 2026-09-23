import { call } from "@orpc/server";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgent } from "#/routes/agents";
import { registerOwner } from "#/routes/owners";
import { getRecord, submitRecord } from "#/routes/records";
import { getSession } from "#/routes/sessions";
import { getTrace, listSessions } from "#/routes/traces";
import { GET, PUT } from "#/pages/v1/content/[sha256]";
import { prisma } from "#/lib/prisma";
import { TEST_ADMIN_TOKEN, adminCtx, ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

type RouteContext = Parameters<typeof PUT>[0];

const REGISTRATION_TOKEN = "test-registration-token";

/** A context carrying a token in X-Admin-Token, as a header-only caller would. */
function tokenCtx(token: string) {
  return {
    context: {
      headers: { "x-admin-token": token } as Record<string, string | string[] | undefined>,
    },
  };
}

function contentRequest(
  method: string,
  sha256: string,
  headers: Record<string, string>,
  body?: string,
) {
  return new Request(`http://localhost/v1/content/${sha256}`, { body, headers, method });
}

describe("Instance administrator", () => {
  let owner: TestOwner;
  let other: TestOwner;
  let agentId: string;
  let recordId: string;
  let sessionId: string;
  let contentDir: string;
  const text = "only this owner uploaded this";
  const sha = createHash("sha256").update(text).digest("hex");

  beforeAll(async () => {
    contentDir = mkdtempSync(path.join(tmpdir(), "rl-admin-"));
    process.env.CONTENT_DIR = contentDir;
    process.env.RL_REGISTRATION_TOKEN = REGISTRATION_TOKEN;
    [owner, other] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    const reg = await call(
      registerAgent,
      { name: `admin-agent-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = reg.agent_id;
    const input = makeObservingInput(agentId);
    await call(submitRecord, input, ctx(owner.apiKey));
    recordId = input.record_id;
    sessionId = input.session_id;
    await PUT({
      params: { sha256: sha },
      request: contentRequest(
        "PUT",
        sha,
        { "content-type": "text/plain", "x-api-key": owner.apiKey },
        text,
      ),
    } as unknown as RouteContext);
  });

  afterAll(async () => {
    Reflect.deleteProperty(process.env, "RL_REGISTRATION_TOKEN");
    await Promise.all([owner.cleanup(), other.cleanup()]);
    rmSync(contentDir, { force: true, recursive: true });
  });

  it("reads another owner's record, session and trace", async () => {
    await expect(call(getRecord, { record_id: recordId }, adminCtx())).resolves.toMatchObject({
      record_id: recordId,
    });
    const session = await call(
      getSession,
      { agent_id: agentId, session_id: sessionId },
      adminCtx(),
    );
    expect(session.records).toHaveLength(1);
    const trace = await call(getTrace, { agent_id: agentId, limit: 100 }, adminCtx());
    expect(trace.records).toHaveLength(1);
  });

  it("lists sessions across owners, each carrying its owner", async () => {
    const { sessions } = await call(listSessions, { limit: 200 }, adminCtx());
    const mine = sessions.find((s) => s.session_id === sessionId);
    expect(mine?.owner_id).toBe(owner.ownerId);
    expect(new Set(sessions.map((s) => s.owner_id)).size).toBeGreaterThanOrEqual(1);
  });

  it("reads content uploaded by an owner", async () => {
    const res = (await GET({
      params: { sha256: sha },
      request: contentRequest("GET", sha, { "x-admin-token": TEST_ADMIN_TOKEN }),
    } as unknown as RouteContext)) as Response;
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(text);
  });

  it("keeps one owner out of another's data", async () => {
    await expect(call(getRecord, { record_id: recordId }, ctx(other.apiKey))).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
    const { sessions } = await call(listSessions, { limit: 200 }, ctx(other.apiKey));
    expect(sessions.find((s) => s.session_id === sessionId)).toBeUndefined();
    const res = (await GET({
      params: { sha256: sha },
      request: contentRequest("GET", sha, { "x-api-key": other.apiKey }),
    } as unknown as RouteContext)) as Response;
    expect(res.status).toBe(404);
  });
});

describe("Registration token", () => {
  const owners: string[] = [];

  beforeAll(() => {
    process.env.RL_REGISTRATION_TOKEN = REGISTRATION_TOKEN;
  });

  afterAll(async () => {
    Reflect.deleteProperty(process.env, "RL_REGISTRATION_TOKEN");
    await prisma.owner.deleteMany({ where: { id: { in: owners } } });
  });

  it("registers an owner", async () => {
    const result = await call(
      registerOwner,
      { email: `reg-${crypto.randomUUID()}@example.com`, wallet_mode: "custodial" as const },
      tokenCtx(REGISTRATION_TOKEN),
    );
    owners.push(result.owner_id);
    expect(result.api_key).toBeTruthy();
  });

  it("reads nothing: it is not an API key and not the administrator", async () => {
    await expect(
      call(listSessions, { limit: 10 }, tokenCtx(REGISTRATION_TOKEN)),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses an unknown token", async () => {
    await expect(
      call(
        registerOwner,
        { email: `reg-${crypto.randomUUID()}@example.com`, wallet_mode: "custodial" as const },
        tokenCtx("not-the-token"),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
