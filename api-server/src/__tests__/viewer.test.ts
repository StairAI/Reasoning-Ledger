import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { objectPath, writeObject } from "#/lib/content-store";
import { contentForViewer } from "#/lib/content-view";
import { prisma } from "#/lib/prisma";
import { cardView, contentText, overviewSections } from "#/lib/trace";
import type { ContentMap, ContentRef, TraceRecord } from "#/lib/trace";
import { makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

function refOf(data: string, mediaType: string): ContentRef {
  return {
    bytes: Buffer.byteLength(data),
    media_type: mediaType,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

async function store(owner: TestOwner, data: string, mediaType: string): Promise<ContentRef> {
  const ref = refOf(data, mediaType);
  await writeObject(owner.ownerId, ref.sha256, new Blob([data]).stream());
  await prisma.contentObject.create({
    data: { bytes: ref.bytes, media_type: mediaType, owner_id: owner.ownerId, sha256: ref.sha256 },
  });
  return ref;
}

function record(fields: Record<string, unknown>): TraceRecord {
  return {
    agent_id: crypto.randomUUID(),
    client_ts_utc: 1,
    record_id: crypto.randomUUID(),
    schema_version: "0.4",
    server_ts_utc: 1,
    session_id: "s",
    ...fields,
  } as TraceRecord;
}

describe("Trace viewer content", () => {
  let owner: TestOwner;
  let other: TestOwner;
  let contentDir: string;
  const refs: Record<string, ContentRef> = {};

  beforeAll(async () => {
    contentDir = mkdtempSync(path.join(tmpdir(), "rl-viewer-"));
    process.env.CONTENT_DIR = contentDir;
    [owner, other] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    refs.prompt = await store(owner, "Should we act?", "text/plain; charset=utf-8");
    refs.input = await store(owner, '{"query":"viewer","n":1}', "application/json");
    refs.image = await store(owner, "binary bytes", "image/png");
    refs.deleted = await store(owner, "gone", "text/plain; charset=utf-8");
    await prisma.contentObject.update({
      data: { deleted_at: new Date() },
      where: { owner_id_sha256: { owner_id: owner.ownerId, sha256: refs.deleted.sha256 } },
    });
    refs.tampered = await store(owner, "original", "text/plain; charset=utf-8");
    writeFileSync(objectPath(owner.ownerId, refs.tampered.sha256), "changed");
    refs.foreign = await store(other, "another owner's text", "text/plain; charset=utf-8");
  });

  afterAll(async () => {
    await Promise.all([owner.cleanup(), other.cleanup()]);
    rmSync(contentDir, { force: true, recursive: true });
  });

  it("reads the signed-in owner's content, and only theirs", async () => {
    const contents = await contentForViewer(owner.ownerId, [
      record({
        behavior: "Thinking",
        inputs: [],
        output_payload: refs.deleted,
        prompt: refs.prompt,
      }),
      record({
        behavior: "ToolCalling",
        input_payload: refs.input,
        outcome: "success",
        output_payload: refs.image,
      }),
      record({ behavior: "Reflecting", inputs: [], output_payload: refs.tampered }),
      record({ behavior: "Reflecting", inputs: [], output_payload: refs.foreign }),
    ]);
    expect(contents[refs.prompt.sha256]).toStrictEqual({ state: "text", text: "Should we act?" });
    expect(contents[refs.input.sha256]).toStrictEqual({
      state: "json",
      value: { n: 1, query: "viewer" },
    });
    expect(contents[refs.image.sha256]).toStrictEqual({ state: "binary" });
    expect(contents[refs.deleted.sha256]).toStrictEqual({ state: "deleted" });
    expect(contents[refs.tampered.sha256]).toStrictEqual({ state: "unreadable" });
    expect(contents[refs.foreign.sha256]).toStrictEqual({ state: "missing" });
  });

  it("leaves records without references alone", async () => {
    await expect(
      contentForViewer(owner.ownerId, [
        record({ behavior: "Thinking", inputs: [], output_payload: "Yes", prompt: "Act?" }),
      ]),
    ).resolves.toStrictEqual({});
  });
});

describe("Trace viewer rendering", () => {
  const prompt: ContentRef = { bytes: 14, media_type: "text/plain", sha256: "a".repeat(64) };
  const payload: ContentRef = { bytes: 9, media_type: "application/json", sha256: "b".repeat(64) };
  const contents: ContentMap = {
    [prompt.sha256]: { state: "text", text: "Should we act?" },
    [payload.sha256]: { state: "json", value: { ok: true } },
  };

  it("shows referenced content in cards and the inspector", () => {
    const thinking = record({
      behavior: "Thinking",
      executor: "ai",
      inputs: [],
      output_payload: payload,
      prompt,
      record_phase: "post_execution",
      sequence: 7,
    });
    expect(cardView(thinking, contents).description).toBe("Should we act?");
    const sections = overviewSections(thinking, contents);
    expect(sections[0]).toStrictEqual({
      kind: "rows",
      label: "RECORD",
      rows: [
        ["executor", "ai"],
        ["phase", "post execution"],
        ["sequence", "7"],
      ],
    });
    expect(sections).toContainEqual({ kind: "text", label: "PROMPT", text: "Should we act?" });
    expect(sections).toContainEqual({
      kind: "text",
      label: "OUTPUT",
      text: JSON.stringify({ ok: true }, null, 2),
    });
  });

  it("says why content cannot be shown", () => {
    const missing: ContentRef = { bytes: 2048, media_type: "image/png", sha256: "c".repeat(64) };
    expect(contentText(missing, { [missing.sha256]: { state: "binary" } })).toBe(
      "[binary content: 2,048 bytes, image/png]",
    );
    expect(contentText(missing, { [missing.sha256]: { state: "deleted" } })).toBe(
      "[content deleted: 2,048 bytes, image/png]",
    );
    expect(contentText(missing, {})).toBe("[content not available: 2,048 bytes, image/png]");
  });

  it("shows text held in older records as it is", () => {
    const legacy = record({
      behavior: "Thinking",
      inputs: [],
      output_payload: "Yes",
      prompt: "Act?",
    });
    expect(cardView(legacy).description).toBe("Act?");
  });

  it("takes a tool call's status from outcome, and from success in older records", () => {
    const call = (fields: Record<string, unknown>) =>
      cardView(record({ behavior: "ToolCalling", description: "d", tool_meta: {}, ...fields }))
        .status;
    expect(call({ outcome: "success" })).toStrictEqual({ kind: "success", label: "SUCCESS" });
    expect(call({ outcome: "timeout" })).toStrictEqual({ kind: "fail", label: "TIMEOUT" });
    expect(call({ outcome: "escalated" })).toStrictEqual({ kind: "neutral", label: "ESCALATED" });
    expect(call({ schema_version: "0.3", success: true })).toStrictEqual({
      kind: "success",
      label: "SUCCESS",
    });
    expect(call({ schema_version: "0.3", success: false })).toStrictEqual({
      kind: "fail",
      label: "FAILED",
    });
  });

  it("renders an Attesting record as a person's disposition", () => {
    const attesting = record({
      behavior: "Attesting",
      disposition: "reject",
      executor: "human",
      gate_kind: "release",
      operator_id: "reviewer-1",
      reason: "numbers do not match",
      record_phase: "concurrent",
      written_by: { component: "review-ui", credential: "session" },
    });
    expect(cardView(attesting)).toStrictEqual({
      chip: "RELEASE",
      description: "reviewer-1 · numbers do not match",
      status: { kind: "fail", label: "REJECTED" },
      upstream: 0,
    });
    expect(overviewSections(attesting)).toContainEqual({
      kind: "rows",
      label: "CHECKPOINT",
      rows: [
        ["operator", "reviewer-1"],
        ["gate", "release"],
        ["written by", "review-ui · session"],
      ],
    });
  });
});
