import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { objectPath, writeObject } from "#/lib/content-store";
import { contentForViewer, encryptionForViewer, jsonForScript } from "#/lib/content-view";
import { prisma } from "#/lib/prisma";
import {
  BEHAVIOR_META,
  LEGEND_ORDER,
  cardView,
  contentText,
  contentValue,
  depIds,
  encryptedPlaceholder,
  overviewSections,
  payloadOnly,
} from "#/lib/trace";
import type { ContentMap, ContentRef, TraceRecord } from "#/lib/trace";
import { SCHEMA_VERSION } from "#/generated/version";
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
    schema_version: SCHEMA_VERSION,
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

  it("reads content at the positions 0.5 added", async () => {
    const contents = await contentForViewer(owner.ownerId, [
      record({ asked: refs.prompt, behavior: "Escalating", kind: "question" }),
      record({ behavior: "Delegating", goal: refs.input, kind: "spawn", result: refs.image }),
      record({ behavior: "Memorizing", op: "add", scope: "user", target: refs.deleted }),
      record({
        behavior: "Other",
        model_invocation: { model_name: null, provider: null, replay_of: refs.tampered },
      }),
    ]);
    expect(Object.keys(contents).toSorted()).toStrictEqual(
      [refs.prompt, refs.input, refs.image, refs.deleted, refs.tampered]
        .map((ref) => ref.sha256)
        .toSorted(),
    );
    expect(contents[refs.prompt.sha256]).toStrictEqual({ state: "text", text: "Should we act?" });
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
    const sections = overviewSections(attesting);
    expect(sections).toContainEqual({
      kind: "rows",
      label: "RECORD",
      rows: [
        ["executor", "human"],
        ["phase", "concurrent"],
        ["written by", "review-ui · session"],
      ],
    });
    expect(sections).toContainEqual({
      kind: "rows",
      label: "CHECKPOINT",
      rows: [
        ["operator", "reviewer-1"],
        ["gate", "release"],
      ],
    });
  });

  it("shows the dispositions 0.5 added and where the person answered", () => {
    const attesting = (fields: Record<string, unknown>) =>
      record({ behavior: "Attesting", gate_kind: "question", operator_id: "op", ...fields });
    expect(
      cardView(attesting({ disposition: "cancel", outcome: "cancelled" })).status,
    ).toStrictEqual({ kind: "neutral", label: "CANCELLED" });
    const silent = attesting({
      channel: "headless",
      disposition: "no_response",
      outcome: "timeout",
      seen_completeness: "unknown",
    });
    expect(cardView(silent).status).toStrictEqual({ kind: "fail", label: "NO RESPONSE" });
    expect(overviewSections(silent)).toContainEqual({
      kind: "rows",
      label: "CHECKPOINT",
      rows: [
        ["operator", "op"],
        ["gate", "question"],
        ["channel", "headless"],
        ["seen completeness", "unknown"],
      ],
    });
  });

  it("lists the 0.5 behaviours in the legend, each with its own style", () => {
    expect(LEGEND_ORDER).toStrictEqual([
      "Observing",
      "ToolCalling",
      "Planning",
      "Thinking",
      "Escalating",
      "Attesting",
      "Delegating",
      "Memorizing",
      "Acting",
      "Reflecting",
    ]);
    const tokens = Object.values(BEHAVIOR_META).map((meta) => meta.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(BEHAVIOR_META.Planning.label).toBe("PLANNING");
  });

  it("renders an Escalating record as a question to a person", () => {
    const asked: ContentRef = { bytes: 17, media_type: "text/plain", sha256: "d".repeat(64) };
    const escalating = record({
      asked,
      behavior: "Escalating",
      default: "no",
      duration_ms: 42_000,
      executor: "ai",
      kind: "permission",
      options: ["yes", "no"],
      outcome: "timeout",
      record_phase: "concurrent",
    });
    const shown: ContentMap = { [asked.sha256]: { state: "text", text: "Run the migration?" } };
    expect(cardView(escalating, shown)).toStrictEqual({
      chip: "PERMISSION",
      description: "Run the migration?",
      status: { kind: "fail", label: "TIMEOUT" },
      upstream: 0,
    });
    expect(overviewSections(escalating, shown)).toStrictEqual([
      {
        kind: "rows",
        label: "RECORD",
        rows: [
          ["executor", "ai"],
          ["phase", "concurrent"],
          ["duration", "42,000 ms"],
        ],
      },
      {
        kind: "rows",
        label: "ESCALATION",
        rows: [
          ["kind", "permission"],
          ["default", "no"],
        ],
      },
      { kind: "text", label: "ASKED", text: "Run the migration?" },
      {
        kind: "rows",
        label: "OPTIONS",
        rows: [
          ["1", "yes"],
          ["2", "no"],
        ],
      },
      { kind: "status", label: "OUTCOME", status: { kind: "fail", label: "TIMEOUT" } },
    ]);
  });

  it("renders a Delegating record as a goal handed to another agent", () => {
    const delegating = record({
      awaited: true,
      behavior: "Delegating",
      child_session_id: "child-1",
      delegate_agent_id: "code-reviewer",
      goal: prompt,
      kind: "spawn",
      outcome: "success",
      result: payload,
      upstream_record_id: [crypto.randomUUID()],
    });
    expect(cardView(delegating, contents)).toStrictEqual({
      chip: "SPAWN",
      description: "code-reviewer · Should we act?",
      status: { kind: "success", label: "SUCCESS" },
      upstream: 1,
    });
    const sections = overviewSections(delegating, contents);
    expect(sections).toContainEqual({
      kind: "rows",
      label: "DELEGATION",
      rows: [
        ["kind", "spawn"],
        ["delegate", "code-reviewer"],
        ["child session", "child-1"],
        ["awaited", "true"],
      ],
    });
    expect(sections).toContainEqual({ kind: "text", label: "GOAL", text: "Should we act?" });
    expect(sections).toContainEqual({
      kind: "text",
      label: "RESULT",
      text: JSON.stringify({ ok: true }, null, 2),
    });
  });

  it("renders a Memorizing record as a write to lasting state", () => {
    const approval = crypto.randomUUID();
    const memorizing = record({
      approved_by: approval,
      behavior: "Memorizing",
      op: "update",
      outcome: "success",
      scope: "project",
      target: prompt,
    });
    expect(cardView(memorizing, contents)).toStrictEqual({
      chip: "UPDATE · PROJECT",
      description: "Should we act?",
      status: { kind: "success", label: "SUCCESS" },
      upstream: 0,
    });
    expect(overviewSections(memorizing, contents)).toContainEqual({
      kind: "rows",
      label: "MEMORY",
      rows: [
        ["scope", "project"],
        ["op", "update"],
        ["approved by", approval],
      ],
    });
  });

  it("shows a Thinking record's output when it has no prompt", () => {
    const thinking = record({ behavior: "Thinking", output_payload: prompt });
    const card = cardView(thinking, contents);
    expect(card).toMatchObject({ description: "Should we act?" });
    expect(card.chip).toBeUndefined();
    const labels = overviewSections(thinking, contents).map((section) => section.label);
    expect(labels).not.toContain("PROMPT");
    expect(labels).not.toContain("STEPS");
  });

  it("shows a Planning record's goal, steps, contingencies and the plan it revises", () => {
    const revised = crypto.randomUUID();
    const planning = record({
      behavior: "Planning",
      contingencies: ["roll back"],
      goal: "ship the fix",
      revision_of: revised,
      steps: [
        { description: "read the failing test", index: 0 },
        { depends_on: [0], description: "patch the parser", index: 1 },
      ],
    });
    expect(cardView(planning)).toMatchObject({ chip: "2 STEPS", description: "ship the fix" });
    expect(overviewSections(planning)).toStrictEqual([
      { kind: "text", label: "GOAL", text: "ship the fix" },
      { kind: "rows", label: "PLAN", rows: [["revision of", revised]] },
      {
        kind: "rows",
        label: "STEPS",
        rows: [
          ["0", "read the failing test"],
          ["1", "patch the parser (after 0)"],
        ],
      },
      { kind: "code", label: "CONTINGENCIES", value: ["roll back"] },
    ]);
  });

  it("shows the base fields 0.5 added with the others", () => {
    const onBehalfOf = crypto.randomUUID();
    const acting = record({
      action_summary: "fill",
      action_type: "order.fill",
      behavior: "Acting",
      classification: {
        alternatives: [{ behavior: "ToolCalling", confidence: 0.25 }],
        confidence: 0.75,
        mapper: "mapper@1",
        source: "rule",
      },
      error_type: "http.5xx",
      execution_status: "failed",
      executor: "det",
      on_behalf_of_agent_id: onBehalfOf,
      outcome: "failure",
      record_phase: "post_execution",
      target_system: "exchange",
      written_by: { component: "platform", credential: "service-key" },
    });
    expect(overviewSections(acting)[0]).toStrictEqual({
      kind: "rows",
      label: "RECORD",
      rows: [
        ["executor", "det"],
        ["phase", "post execution"],
        ["outcome", "failure"],
        ["error type", "http.5xx"],
        ["written by", "platform · service-key"],
        ["on behalf of", onBehalfOf],
        ["classification", "rule · mapper@1 · 0.75"],
        ["alternatives", "ToolCalling 0.25"],
      ],
    });
    expect(Object.keys(payloadOnly(acting)).toSorted()).toStrictEqual([
      "action_summary",
      "action_type",
      "execution_status",
      "target_system",
    ]);
  });

  it("still renders a 0.4 Planning record, with its parent among the dependencies", () => {
    const parent = crypto.randomUUID();
    const upstream = crypto.randomUUID();
    const planning = record({
      behavior: "Planning",
      contingencies: ["roll back"],
      goal: "ship the fix",
      model_invocation: { model_name: "m", model_version: "2026-01", provider: "p" },
      parent_record_id: parent,
      schema_version: "0.4",
      steps: [
        { description: "run the tests", index: 0 },
        { depends_on: [0], description: "deploy", index: 1 },
      ],
      upstream_record_id: [upstream],
    });
    expect(cardView(planning)).toStrictEqual({
      chip: "2 STEPS",
      description: "ship the fix",
      upstream: 1,
    });
    expect(overviewSections(planning)).toStrictEqual([
      { kind: "text", label: "GOAL", text: "ship the fix" },
      {
        kind: "rows",
        label: "STEPS",
        rows: [
          ["0", "run the tests"],
          ["1", "deploy (after 0)"],
        ],
      },
      { kind: "code", label: "CONTINGENCIES", value: ["roll back"] },
    ]);
    expect(depIds(planning)).toStrictEqual([parent, upstream]);
  });
});

describe("Trace viewer encrypted content", () => {
  let owner: TestOwner;
  let contentDir: string;

  beforeAll(async () => {
    contentDir = mkdtempSync(path.join(tmpdir(), "rl-viewer-enc-"));
    process.env.CONTENT_DIR = contentDir;
    owner = await makeTestOwner();
  });

  afterAll(async () => {
    await prisma.contentKey.deleteMany({ where: { owner_id: owner.ownerId } });
    await prisma.contentObject.deleteMany({ where: { owner_id: owner.ownerId } });
    await owner.cleanup();
    rmSync(contentDir, { force: true, recursive: true });
  });

  it("hands the browser the ciphertext and the wrapped key, and shows a placeholder until it decrypts", async () => {
    // The server never sees the key: these bytes only have to be stored and handed back.
    const stored = await store(owner, "not really ciphertext", "application/octet-stream");
    const keyId = crypto.randomUUID();
    await prisma.contentKey.create({
      data: {
        key_id: keyId,
        master_key_id: "0123456789abcdef",
        owner_id: owner.ownerId,
        wrap_alg: "A256GCM",
        wrapped_key: Buffer.alloc(60, 1).toString("base64"),
      },
    });
    const ref: ContentRef = {
      ...stored,
      enc: {
        alg: "A256GCM",
        key_id: keyId,
        plaintext_bytes: 4,
        plaintext_media_type: "application/json",
        plaintext_sha256: "a".repeat(64),
      },
    };
    const orphan: ContentRef = { ...ref, enc: { ...ref.enc, key_id: "never-registered" } };
    const records = [
      record({ behavior: "Observing", trigger_payload: ref }),
      record({ behavior: "Acting", output_payload: orphan }),
    ];
    const contents = await contentForViewer(owner.ownerId, records);
    expect(contents[stored.sha256]).toMatchObject({
      alg: "A256GCM",
      bytes: 4,
      ciphertext: Buffer.from("not really ciphertext").toString("base64"),
      key_id: keyId,
      media_type: "application/json",
      state: "encrypted",
    });
    expect(contentText(ref, contents)).toBe(encryptedPlaceholder(stored.sha256));
    expect(contentValue(ref, contents)).toBe(`[encrypted:${stored.sha256}]`);
    expect(cardView(records[0], contents).description).toBe(encryptedPlaceholder(stored.sha256));

    const encryption = await encryptionForViewer(owner.ownerId, contents);
    expect(Object.keys(encryption.objects)).toStrictEqual([stored.sha256]);
    expect(encryption.keys[keyId]).toMatchObject({
      master_key_id: "0123456789abcdef",
      wrap_alg: "A256GCM",
    });
    expect(encryption.keys["never-registered"]).toBeUndefined();
    expect(jsonForScript({ a: "</script><b>&" })).toBe(
      '{"a":"\\u003c/script\\u003e\\u003cb\\u003e\\u0026"}',
    );
  });
});
