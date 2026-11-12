import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_MAX_BYTES, objectPath, s3Key, writeObject } from "#/lib/content-store";
import { contentForViewer } from "#/lib/content-view";
import { prisma } from "#/lib/prisma";
import type { ContentRef, TraceRecord } from "#/lib/trace";
import { GET, HEAD, PUT } from "#/pages/v1/content/[sha256]";
import { SCHEMA_VERSION } from "#/generated/version";
import { startFakeS3 } from "./fake-s3";
import type { FakeS3 } from "./fake-s3";
import { makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

type RouteContext = Parameters<typeof PUT>[0];

const runFile = promisify(execFile);
const apiServer = path.resolve(import.meta.dirname, "../..");
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The inline limit these tests run with: "small" content is at most this, "large" more. */
const INLINE = 16;
const SETTINGS = [
  "CONTENT_STORE",
  "CONTENT_INLINE_MAX_BYTES",
  "CONTENT_S3_BUCKET",
  "CONTENT_S3_ENDPOINT",
  "CONTENT_S3_ACCESS_KEY_ID",
  "CONTENT_S3_SECRET_ACCESS_KEY",
  "CONTENT_S3_REGION",
] as const;

function send(
  handler: typeof PUT,
  method: string,
  sha256: string,
  opts: { key?: string; body?: string | Buffer; type?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.key) {
    headers["x-api-key"] = opts.key;
  }
  if (opts.type) {
    headers["content-type"] = opts.type;
  }
  const request = new Request(`http://localhost/v1/content/${sha256}`, {
    body: Buffer.isBuffer(opts.body) ? new Uint8Array(opts.body) : opts.body,
    headers,
    method,
  });
  return handler({ params: { sha256 }, request } as unknown as RouteContext) as Promise<Response>;
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

/** Run an operator command as the deployment would, with this suite's settings. */
async function operator(
  script: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await runFile("node", [script, ...args], {
      cwd: apiServer,
      env: { ...process.env, ...env },
    });
    return { status: 0, stderr, stdout };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { status: failed.code ?? 1, stderr: failed.stderr ?? "", stdout: failed.stdout ?? "" };
  }
}

describe("Content locations: database, object store and files", () => {
  let fake: FakeS3;
  let owner: TestOwner;
  let contentDir: string;

  beforeAll(async () => {
    fake = await startFakeS3();
    contentDir = mkdtempSync(path.join(tmpdir(), "rl-locations-"));
    Object.assign(process.env, {
      CONTENT_DIR: contentDir,
      CONTENT_INLINE_MAX_BYTES: String(INLINE),
      CONTENT_S3_ACCESS_KEY_ID: "test-access-key",
      CONTENT_S3_BUCKET: fake.bucket,
      CONTENT_S3_ENDPOINT: fake.endpoint,
      CONTENT_S3_SECRET_ACCESS_KEY: "test-secret-key",
      CONTENT_STORE: "s3",
    });
    owner = await makeTestOwner();
  });

  afterEach(() => {
    Object.assign(fake.refuse, { deletes: false, reads: false, writes: false });
    fake.lock.on = false;
  });

  afterAll(async () => {
    for (const name of SETTINGS) {
      Reflect.deleteProperty(process.env, name);
    }
    await owner.cleanup();
    await fake.close();
    rmSync(contentDir, { force: true, recursive: true });
  });

  async function upload(data: string | Buffer) {
    const res = await send(PUT, "PUT", sha(data), {
      body: data,
      key: owner.apiKey,
      type: "text/plain",
    });
    return { body: (await res.json()) as Record<string, unknown>, status: res.status };
  }

  async function locationOf(sha256: string, ownerId = owner.ownerId) {
    const found = await prisma.contentObject.findUniqueOrThrow({
      where: { owner_id_sha256: { owner_id: ownerId, sha256 } },
    });
    return found.location;
  }

  function blob(sha256: string, ownerId = owner.ownerId) {
    return prisma.contentBlob.findUnique({
      where: { owner_id_sha256: { owner_id: ownerId, sha256 } },
    });
  }

  async function blobText(sha256: string) {
    const found = await blob(sha256);
    return found ? Buffer.from(found.data).toString() : undefined;
  }

  async function read(sha256: string) {
    const res = await send(GET, "GET", sha256, { key: owner.apiKey });
    return { status: res.status, text: await res.text() };
  }

  async function readStatus(sha256: string) {
    const res = await send(GET, "GET", sha256, { key: owner.apiKey });
    await res.body?.cancel();
    return res.status;
  }

  async function json(script: string, args: string[]) {
    const result = await operator(script, args);
    return JSON.parse(result.stdout);
  }

  it("keeps content up to the inline limit in the database", async () => {
    const data = "small text";
    const uploaded = await upload(data);
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toStrictEqual({ bytes: 10, media_type: "text/plain", sha256: sha(data) });
    await expect(locationOf(sha(data))).resolves.toBe("db");
    await expect(blobText(sha(data))).resolves.toBe(data);
    expect(fake.objects.has(s3Key(owner.ownerId, sha(data)))).toBeFalsy();
    expect(existsSync(objectPath(owner.ownerId, sha(data)))).toBeFalsy();

    await expect(read(sha(data))).resolves.toStrictEqual({ status: 200, text: data });
    const head = await send(HEAD, "HEAD", sha(data), { key: owner.apiKey });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");

    const again = await upload(data);
    expect(again.status).toBe(200);
  });

  it("puts larger content in the bucket under owner/sha256, with a conditional write", async () => {
    const data = "larger than the inline limit, so it goes to the bucket";
    const uploaded = await upload(data);
    expect(uploaded.status).toBe(201);
    await expect(locationOf(sha(data))).resolves.toBe("s3");
    await expect(blob(sha(data))).resolves.toBeNull();
    const key = s3Key(owner.ownerId, sha(data));
    expect(fake.objects.get(key)?.toString()).toBe(data);
    expect(fake.requests.find((r) => r.method === "PUT" && r.key === key)?.ifNoneMatch).toBe("*");
    await expect(read(sha(data))).resolves.toStrictEqual({ status: 200, text: data });
  });

  it("counts an object already in the bucket as written", async () => {
    const data = "already in the bucket before the upload";
    fake.objects.set(s3Key(owner.ownerId, sha(data)), Buffer.from(data));
    const uploaded = await upload(data);
    expect(uploaded.status).toBe(201);
    await expect(locationOf(sha(data))).resolves.toBe("s3");
    await expect(read(sha(data))).resolves.toStrictEqual({ status: 200, text: data });
  });

  it("refuses to serve an object whose bytes in the bucket no longer match the hash", async () => {
    const data = "an object that will be changed in the bucket";
    await upload(data);
    fake.objects.set(s3Key(owner.ownerId, sha(data)), Buffer.from("changed"));
    await expect(readStatus(sha(data))).resolves.toBe(500);
  });

  it("keeps content in the database while the bucket refuses writes; larger content fails", async () => {
    fake.refuse.writes = true;
    const data = "uploaded while the bucket refuses writes";
    const uploaded = await upload(data);
    expect(uploaded.status).toBe(201);
    await expect(locationOf(sha(data))).resolves.toBe("db");
    await expect(read(sha(data))).resolves.toStrictEqual({ status: 200, text: data });

    const big = Buffer.alloc(FALLBACK_MAX_BYTES + 1, 7);
    const refused = await upload(big);
    expect(refused.status).toBe(503);
    await expect(
      prisma.contentObject.findUnique({
        where: { owner_id_sha256: { owner_id: owner.ownerId, sha256: sha(big) } },
      }),
    ).resolves.toBeNull();
  });

  it("answers 503 while the bucket refuses reads, and the viewer says it is unavailable", async () => {
    const data = "in the bucket, which then refuses reads";
    await upload(data);
    fake.refuse.reads = true;
    await expect(readStatus(sha(data))).resolves.toBe(503);
    const ref: ContentRef = { bytes: data.length, media_type: "text/plain", sha256: sha(data) };
    const contents = await contentForViewer(owner.ownerId, [
      record({ behavior: "Observing", trigger_payload: ref }),
    ]);
    expect(contents[sha(data)]).toStrictEqual({ state: "unavailable" });
  });

  it("shows content from every location in the viewer", async () => {
    const inDb = "db text";
    const inBucket = "text that is long enough for the bucket";
    const inFile = "text kept in a file";
    await upload(inDb);
    await upload(inBucket);
    await writeObject(owner.ownerId, sha(inFile), new Blob([inFile]).stream());
    await prisma.contentObject.create({
      data: {
        bytes: inFile.length,
        location: "fs",
        media_type: "text/plain",
        owner_id: owner.ownerId,
        sha256: sha(inFile),
      },
    });
    const refOf = (text: string): ContentRef => ({
      bytes: text.length,
      media_type: "text/plain",
      sha256: sha(text),
    });
    const contents = await contentForViewer(owner.ownerId, [
      record({ behavior: "Observing", trigger_payload: refOf(inDb) }),
      record({ behavior: "Acting", output_payload: refOf(inBucket) }),
      record({ behavior: "Observing", trigger_payload: refOf(inFile) }),
    ]);
    expect(contents[sha(inDb)]).toStrictEqual({ state: "text", text: inDb });
    expect(contents[sha(inBucket)]).toStrictEqual({ state: "text", text: inBucket });
    expect(contents[sha(inFile)]).toStrictEqual({ state: "text", text: inFile });
  });

  it("deletes content wherever it is, and says when the bucket keeps the bytes", async () => {
    const deleteArgs = (sha256: string) => [
      "--owner",
      owner.ownerId,
      "--sha256",
      sha256,
      "--reason",
      "test",
      "--operator",
      "vitest",
    ];
    const small = "delete me";
    await upload(small);
    const deletedSmall = await operator("scripts/delete-content.mts", deleteArgs(sha(small)));
    expect(deletedSmall.status).toBe(0);
    await expect(blob(sha(small))).resolves.toBeNull();
    await expect(readStatus(sha(small))).resolves.toBe(410);

    const large = "delete me from the bucket as well, please";
    await upload(large);
    const deletedLarge = await operator("scripts/delete-content.mts", deleteArgs(sha(large)));
    expect(deletedLarge.status).toBe(0);
    expect(fake.objects.has(s3Key(owner.ownerId, sha(large)))).toBeFalsy();

    const kept = "the bucket refuses to delete this object";
    await upload(kept);
    fake.refuse.deletes = true;
    const refused = await operator("scripts/delete-content.mts", deleteArgs(sha(kept)));
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain(`s3://${fake.bucket}/${s3Key(owner.ownerId, sha(kept))}`);
    await expect(readStatus(sha(kept))).resolves.toBe(410);
    expect(fake.objects.has(s3Key(owner.ownerId, sha(kept)))).toBeTruthy();
  });

  it("works with a bucket whose lock rule keeps every object (R2)", async () => {
    fake.lock.on = true;
    const data = "in a locked bucket before it was uploaded here";
    fake.objects.set(s3Key(owner.ownerId, sha(data)), Buffer.from(data));
    // R2 answers 409 ObjectLockedByBucketPolicy, not 412, for an object that is already there.
    const uploaded = await upload(data);
    expect(uploaded.status).toBe(201);
    await expect(locationOf(sha(data))).resolves.toBe("s3");

    const first = await operator("scripts/content.mts", ["check"]);
    const second = await operator("scripts/content.mts", ["check"]);
    expect([first.status, second.status]).toStrictEqual([0, 0]);

    const deleted = await operator("scripts/delete-content.mts", [
      "--owner",
      owner.ownerId,
      "--sha256",
      sha(data),
      "--reason",
      "test",
      "--operator",
      "vitest",
    ]);
    expect(deleted.status).toBe(3);
    expect(deleted.stderr).toContain("lock rule");
    expect(fake.objects.has(s3Key(owner.ownerId, sha(data)))).toBeTruthy();
  });

  it("checks the settings and the bucket before the server starts", async () => {
    const ok = await operator("scripts/content.mts", ["check"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("takes writes and returns them");

    fake.refuse.writes = true;
    const down = await operator("scripts/content.mts", ["check"]);
    expect(down.status).toBe(1);
    expect(down.stderr).toContain("cannot write to bucket");

    const noBucket = await operator("scripts/content.mts", ["check"], { CONTENT_S3_BUCKET: "" });
    expect(noBucket.status).toBe(1);
    expect(noBucket.stderr).toContain("CONTENT_STORE=s3 needs CONTENT_S3_BUCKET");

    const badLimit = await operator("scripts/content.mts", ["check"], {
      CONTENT_INLINE_MAX_BYTES: "4k",
    });
    expect(badLimit.status).toBe(1);
    expect(badLimit.stderr).toContain("CONTENT_INLINE_MAX_BYTES");
  });

  it("moves content between locations and back, checking every object", async () => {
    const mover = await makeTestOwner();
    try {
      // Uploaded while content went to files only, as before this release.
      const small = "small, in a file";
      const large = "large enough for the bucket, in a file for now";
      for (const data of [small, large]) {
        await writeObject(mover.ownerId, sha(data), new Blob([data]).stream());
        await prisma.contentObject.create({
          data: {
            bytes: data.length,
            media_type: "text/plain",
            owner_id: mover.ownerId,
            sha256: sha(data),
          },
        });
      }
      const at = (data: string) => locationOf(sha(data), mover.ownerId);
      const only = ["--owner", mover.ownerId, "--json"];

      const census = await json("scripts/content.mts", ["census", "--json"]);
      expect(census.would_move).toStrictEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "fs", to: "db" }),
          expect.objectContaining({ from: "fs", to: "s3" }),
        ]),
      );

      const dry = await operator("scripts/content.mts", ["move", "--dry-run", ...only]);
      expect(JSON.parse(dry.stdout).moved).toStrictEqual({
        "fs→db": { bytes: small.length, objects: 1 },
        "fs→s3": { bytes: large.length, objects: 1 },
      });
      await expect(at(small)).resolves.toBe("fs");

      const moved = await operator("scripts/content.mts", ["move", ...only]);
      expect(moved.status).toBe(0);
      expect(JSON.parse(moved.stdout)).toMatchObject({ problem_count: 0 });
      await expect(at(small)).resolves.toBe("db");
      await expect(at(large)).resolves.toBe("s3");
      expect(fake.objects.get(s3Key(mover.ownerId, sha(large)))?.toString()).toBe(large);
      // Files stay behind until the operator removes them.
      expect(existsSync(objectPath(mover.ownerId, sha(small)))).toBeTruthy();
      expect(existsSync(objectPath(mover.ownerId, sha(large)))).toBeTruthy();

      const verified = await operator("scripts/content.mts", ["verify", ...only]);
      expect(verified.status).toBe(0);
      expect(JSON.parse(verified.stdout).checked).toMatchObject({
        db: { objects: 1 },
        s3: { objects: 1 },
      });

      const again = await json("scripts/content.mts", ["move", ...only]);
      expect(again.already_in_place).toBe(2);
      expect(again.moved).toStrictEqual({});

      const back = await operator("scripts/content.mts", ["move", "--to", "fs", ...only]);
      expect(back.status).toBe(0);
      await expect(at(small)).resolves.toBe("fs");
      await expect(at(large)).resolves.toBe("fs");
      // A database copy goes once its object is elsewhere.
      await expect(
        prisma.contentBlob.findUnique({
          where: { owner_id_sha256: { owner_id: mover.ownerId, sha256: sha(small) } },
        }),
      ).resolves.toBeNull();

      writeFileSync(objectPath(mover.ownerId, sha(small)), "damaged");
      const damaged = await operator("scripts/content.mts", ["verify", ...only]);
      expect(damaged.status).toBe(4);
      expect(JSON.parse(damaged.stdout).problems).toStrictEqual([
        expect.objectContaining({ location: "fs", sha256: sha(small) }),
      ]);
    } finally {
      await mover.cleanup();
    }
  });
});
