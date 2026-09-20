import { call } from "@orpc/server";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { objectPath } from "#/lib/content-store";
import { prisma } from "#/lib/prisma";
import { GET, HEAD, PUT } from "#/pages/v1/content/[sha256]";
import { registerAgent } from "#/routes/agents";
import { getRecord, submitRecord } from "#/routes/records";
import { ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

type RouteContext = Parameters<typeof PUT>[0];

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function send(
  handler: typeof PUT,
  method: string,
  sha256: string,
  opts: { key?: string; body?: string; type?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.key) {
    headers["x-api-key"] = opts.key;
  }
  if (opts.type) {
    headers["content-type"] = opts.type;
  }
  const request = new Request(`http://localhost/v1/content/${sha256}`, {
    body: opts.body,
    headers,
    method,
  });
  return handler({ params: { sha256 }, request } as unknown as RouteContext) as Promise<Response>;
}

describe("Content library", () => {
  let owner: TestOwner;
  let ownerB: TestOwner;
  let agentId: string;
  let contentDir: string;

  beforeAll(async () => {
    contentDir = mkdtempSync(path.join(tmpdir(), "rl-content-"));
    process.env.CONTENT_DIR = contentDir;
    [owner, ownerB] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    const reg = await call(
      registerAgent,
      { name: `content-agent-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = reg.agent_id;
  });

  afterAll(async () => {
    await Promise.all([owner.cleanup(), ownerB.cleanup()]);
    rmSync(contentDir, { force: true, recursive: true });
  });

  async function upload(text: string, key = owner.apiKey) {
    const res = await send(PUT, "PUT", sha(text), { body: text, key, type: "text/plain" });
    return { body: (await res.json()) as Record<string, unknown>, status: res.status };
  }

  function thinking(prompt: { sha256: string; bytes: number }) {
    return {
      ...makeObservingInput(agentId),
      behavior: "Thinking" as const,
      executor: "ai" as const,
      inputs: [],
      output_payload: { ...prompt, media_type: "text/plain" },
      prompt: { ...prompt, media_type: "text/plain" },
      trigger_description: undefined,
      trigger_payload_summary: undefined,
      trigger_source: undefined,
      trigger_type: undefined,
    };
  }

  it("stores content under its hash and returns a content reference", async () => {
    const first = await upload("hello content");
    expect(first.status).toBe(201);
    expect(first.body).toStrictEqual({
      bytes: 13,
      media_type: "text/plain",
      sha256: sha("hello content"),
    });

    const again = await upload("hello content");
    expect(again.status).toBe(200);
    expect(again.body).toStrictEqual(first.body);
  });

  it("reads back the same bytes, and HEAD reports size and type", async () => {
    await upload("read me");
    const head = await send(HEAD, "HEAD", sha("read me"), { key: owner.apiKey });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("7");
    expect(head.headers.get("content-type")).toBe("text/plain");

    const get = await send(GET, "GET", sha("read me"), { key: owner.apiKey });
    expect(get.status).toBe(200);
    await expect(get.text()).resolves.toBe("read me");
  });

  it("rejects a body that does not match the hash and stores nothing", async () => {
    const res = await send(PUT, "PUT", sha("expected"), {
      body: "something else",
      key: owner.apiKey,
    });
    expect(res.status).toBe(400);
    const head = await send(HEAD, "HEAD", sha("expected"), { key: owner.apiKey });
    expect(head.status).toBe(404);
  });

  it("keeps each owner's content separate", async () => {
    await upload("owner A only");
    const readByB = await send(GET, "GET", sha("owner A only"), { key: ownerB.apiKey });
    expect(readByB.status).toBe(404);
    const uploadByB = await upload("owner A only", ownerB.apiKey);
    expect(uploadByB.status).toBe(201);
  });

  it("needs an API key and a well-formed hash", async () => {
    const anonymous = await send(GET, "GET", sha("x"));
    expect(anonymous.status).toBe(401);
    const malformed = await send(GET, "GET", "not-a-hash", { key: owner.apiKey });
    expect(malformed.status).toBe(400);
  });

  it("refuses content over the size limit", async () => {
    process.env.CONTENT_MAX_BYTES = "10";
    try {
      const tooLarge = await upload("definitely more than ten bytes");
      expect(tooLarge.status).toBe(413);
    } finally {
      delete process.env.CONTENT_MAX_BYTES;
    }
  });

  it("refuses to serve content whose stored bytes no longer match the hash", async () => {
    await upload("tamper target");
    writeFileSync(objectPath(owner.ownerId, sha("tamper target")), "tampered");
    const res = await send(GET, "GET", sha("tamper target"), { key: owner.apiKey });
    expect(res.status).toBe(500);
  });

  it("accepts a record whose content references were uploaded by the same owner", async () => {
    const { body } = await upload("a prompt");
    const record = thinking({ bytes: body.bytes as number, sha256: body.sha256 as string });
    await call(submitRecord, record, ctx(owner.apiKey));
    const stored = await call(getRecord, { record_id: record.record_id }, ctx(owner.apiKey));
    expect(stored["prompt"]).toStrictEqual({
      bytes: 8,
      media_type: "text/plain",
      sha256: sha("a prompt"),
    });
  });

  it("rejects a record that references content not uploaded or with the wrong size", async () => {
    await expect(
      call(submitRecord, thinking({ bytes: 3, sha256: sha("never uploaded") }), ctx(owner.apiKey)),
    ).rejects.toMatchObject({ message: expect.stringContaining("has not been uploaded") });

    const { body } = await upload("sized");
    await expect(
      call(
        submitRecord,
        thinking({ bytes: 999, sha256: body.sha256 as string }),
        ctx(owner.apiKey),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("the reference says 999") });
  });

  it("deletes content through the operator command: 410 afterwards, logged, records untouched", async () => {
    const { body } = await upload("delete me");
    const hash = body.sha256 as string;
    const record = thinking({ bytes: 9, sha256: hash });
    await call(submitRecord, record, ctx(owner.apiKey));

    const run = () =>
      execFileSync(
        "node",
        [
          "scripts/delete-content.mts",
          "--owner",
          owner.ownerId,
          "--sha256",
          hash,
          "--reason",
          "test",
          "--operator",
          "vitest",
        ],
        { cwd: path.resolve(import.meta.dirname, "../.."), env: process.env, stdio: "pipe" },
      );
    run();

    const readAfter = await send(GET, "GET", hash, { key: owner.apiKey });
    expect(readAfter.status).toBe(410);
    const headAfter = await send(HEAD, "HEAD", hash, { key: owner.apiKey });
    expect(headAfter.status).toBe(410);
    const logged = await prisma.contentDeletion.findMany({
      where: { owner_id: owner.ownerId, sha256: hash },
    });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ operator: "vitest", reason: "test" });

    const stored = await call(getRecord, { record_id: record.record_id }, ctx(owner.apiKey));
    expect(stored["prompt"]).toMatchObject({ sha256: hash });

    await expect(
      call(submitRecord, thinking({ bytes: 9, sha256: hash }), ctx(owner.apiKey)),
    ).rejects.toMatchObject({ message: expect.stringContaining("was deleted") });
    expect(run).toThrow(/Command failed/);
  });
});
