/**
 * Content store (design §3): raw bytes addressed by SHA-256, one namespace per
 * owner. The content_objects table is the source of truth for ownership and
 * deletion state, and records where each object's bytes are (`location`):
 *
 *   fs  a file, {CONTENT_DIR}/{owner_id}/{sha256}: the default
 *   db  a row of content_blobs, for objects of at most CONTENT_INLINE_MAX_BYTES
 *   s3  an object in an S3-compatible bucket (CONTENT_S3_*), key {owner_id}/{sha256}
 *
 * New content goes where `placement` says; reads go where the row says, so the
 * three coexist and objects can be moved one at a time (scripts/content.mts).
 * Bytes are checked against their hash before they are stored and before
 * anything is returned.
 *
 * This module only moves bytes: it reads and writes no table, and imports
 * nothing from the rest of the server, so the operator commands use it too.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

export const SHA256_HEX = /^[0-9a-f]{64}$/;

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Bytes held in memory on their way through; a larger object goes through a temporary file. */
const MEMORY_BYTES = 8 * 1024 * 1024;

/**
 * When the object store cannot take an object, one of at most this many bytes
 * is kept in the database instead (and counted, and moved later), so an upload
 * does not fail because the bucket is briefly out of reach.
 */
export const FALLBACK_MAX_BYTES = 1024 * 1024;

/** Where an object's bytes are. */
export type ContentLocation = "fs" | "db" | "s3";

export const CONTENT_LOCATIONS: readonly ContentLocation[] = ["fs", "db", "s3"];

export function isContentLocation(value: unknown): value is ContentLocation {
  return value === "fs" || value === "db" || value === "s3";
}

export type ContentStoreErrorKind =
  | "too_large"
  | "hash_mismatch"
  | "integrity"
  | "missing"
  | "unavailable"
  | "denied"
  | "config";

export class ContentStoreError extends Error {
  readonly kind: ContentStoreErrorKind;

  constructor(kind: ContentStoreErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContentStoreError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Root directory of the file store: CONTENT_DIR, else ./data/content under the working directory. */
export function contentDir(): string {
  return path.resolve(process.env.CONTENT_DIR ?? "data/content");
}

/** Largest accepted object in bytes: CONTENT_MAX_BYTES, else 64 MiB. */
export function maxContentBytes(): number {
  const configured = Number(process.env.CONTENT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

export interface S3Settings {
  bucket: string;
  region: string;
  /** Set for a service other than AWS S3 (R2, MinIO, …); requests then use path-style addresses. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface ContentConfig {
  /** Where new content larger than `inlineMax` goes. */
  store: "fs" | "s3";
  /** Objects of at most this many bytes go to the database; 0 keeps none there. */
  inlineMax: number;
  /** The object store, when one is configured (also when new content no longer goes there). */
  s3?: S3Settings;
}

function setting(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/**
 * The content store's settings, checked. Throws ContentStoreError("config")
 * naming the variable to fix; the image's entrypoint runs this check
 * (scripts/content.mts check) before it starts the server.
 */
export function contentConfig(): ContentConfig {
  const store = setting("CONTENT_STORE") ?? "fs";
  if (store !== "fs" && store !== "s3") {
    throw new ContentStoreError("config", `CONTENT_STORE must be fs or s3, not ${store}`);
  }
  const inline = setting("CONTENT_INLINE_MAX_BYTES") ?? "0";
  if (!/^\d+$/.test(inline)) {
    throw new ContentStoreError(
      "config",
      `CONTENT_INLINE_MAX_BYTES must be a whole number of bytes, not ${inline}`,
    );
  }
  const bucket = setting("CONTENT_S3_BUCKET");
  let s3: S3Settings | undefined;
  if (bucket) {
    const endpoint = setting("CONTENT_S3_ENDPOINT");
    const region = setting("CONTENT_S3_REGION") ?? (endpoint ? "auto" : undefined);
    if (!region) {
      throw new ContentStoreError(
        "config",
        "CONTENT_S3_REGION is required with CONTENT_S3_BUCKET (the bucket's AWS region)",
      );
    }
    const accessKeyId = setting("CONTENT_S3_ACCESS_KEY_ID");
    const secretAccessKey = setting("CONTENT_S3_SECRET_ACCESS_KEY");
    if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
      throw new ContentStoreError(
        "config",
        "set both CONTENT_S3_ACCESS_KEY_ID and CONTENT_S3_SECRET_ACCESS_KEY, or neither",
      );
    }
    s3 = {
      bucket,
      region,
      ...(endpoint && { endpoint }),
      ...(accessKeyId && secretAccessKey && { accessKeyId, secretAccessKey }),
    };
  }
  if (store === "s3" && !s3) {
    throw new ContentStoreError("config", "CONTENT_STORE=s3 needs CONTENT_S3_BUCKET");
  }
  return { inlineMax: Number(inline), store, ...(s3 && { s3 }) };
}

/** Where new content of `bytes` bytes goes. */
export function placement(bytes: number, config: ContentConfig = contentConfig()): ContentLocation {
  return config.inlineMax > 0 && bytes <= config.inlineMax ? "db" : config.store;
}

// ---------------------------------------------------------------------------
// Bytes in transit
// ---------------------------------------------------------------------------

/** Bytes on their way through, checked against their hash: in memory, or in a file. */
export interface Held {
  size: number;
  /** The bytes, when they are held in memory. */
  data?: Buffer;
  /** Otherwise the file that holds them. */
  file?: string;
  /** Whether `file` is a temporary copy, which `release` removes. */
  temporary: boolean;
  /** Base64 MD5 of the bytes, for an object store's Content-MD5 check. */
  md5: string;
}

async function write(out: WriteStream, chunk: Buffer): Promise<void> {
  if (!out.write(chunk)) {
    await once(out, "drain");
  }
}

async function finish(out: WriteStream): Promise<void> {
  out.end();
  await finished(out);
}

/**
 * Read `source` to its end, counting and hashing: up to MEMORY_BYTES stay in
 * memory, anything larger goes to a temporary file. The digest must be
 * `sha256`, or nothing is kept and `mismatch` is thrown.
 */
async function hold(
  source: AsyncIterable<Uint8Array>,
  opts: { sha256: string; limit: number; mismatch: "hash_mismatch" | "integrity" },
): Promise<Held> {
  const hash = createHash("sha256");
  const md5 = createHash("md5");
  const chunks: Buffer[] = [];
  let size = 0;
  let spill: { file: string; out: WriteStream } | undefined;
  try {
    for await (const piece of source) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      size += chunk.length;
      if (size > opts.limit) {
        throw new ContentStoreError("too_large", `content exceeds the ${opts.limit}-byte limit`);
      }
      hash.update(chunk);
      md5.update(chunk);
      if (!spill && size > MEMORY_BYTES) {
        const file = path.join(await mkdtemp(path.join(tmpdir(), "rl-content-")), "bytes");
        spill = { file, out: createWriteStream(file, { flags: "wx" }) };
        for (const earlier of chunks.splice(0)) {
          await write(spill.out, earlier);
        }
      }
      if (spill) {
        await write(spill.out, chunk);
      } else {
        chunks.push(chunk);
      }
    }
    if (spill) {
      await finish(spill.out);
    }
    const digest = hash.digest("hex");
    if (digest !== opts.sha256) {
      throw new ContentStoreError(
        opts.mismatch,
        opts.mismatch === "hash_mismatch"
          ? `body hashes to ${digest}, not ${opts.sha256}`
          : `stored content ${opts.sha256} failed its hash check`,
      );
    }
    const md5Digest = md5.digest("base64");
    return spill
      ? { file: spill.file, md5: md5Digest, size, temporary: true }
      : { data: Buffer.concat(chunks), md5: md5Digest, size, temporary: false };
  } catch (error) {
    if (spill) {
      spill.out.destroy();
      await rm(path.dirname(spill.file), { force: true, recursive: true });
    }
    throw error;
  }
}

/** Receive an upload: counted against the size limit and checked against `sha256`. */
export function receive(sha256: string, body: ReadableStream<Uint8Array> | null): Promise<Held> {
  const source = body
    ? Readable.fromWeb(body as unknown as NodeWebReadableStream)
    : Readable.from([]);
  return hold(source, { limit: maxContentBytes(), mismatch: "hash_mismatch", sha256 });
}

/** Bytes kept in the database, checked against their hash. */
export function verifyBlob(sha256: string, data: Uint8Array): Held {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (createHash("sha256").update(buffer).digest("hex") !== sha256) {
    throw new ContentStoreError("integrity", `stored content ${sha256} failed its hash check`);
  }
  return {
    data: buffer,
    md5: createHash("md5").update(buffer).digest("base64"),
    size: buffer.length,
    temporary: false,
  };
}

/** A stream of the held bytes. */
export function openHeld(held: Held): Readable {
  return held.data ? Readable.from([held.data]) : createReadStream(held.file as string);
}

/** The held bytes, in memory. */
export async function bufferOf(held: Held): Promise<Buffer> {
  return held.data ?? (await readFile(held.file as string));
}

/** Remove a temporary copy; harmless for bytes held any other way. */
export async function release(held: Held): Promise<void> {
  if (held.temporary && held.file) {
    await rm(path.dirname(held.file), { force: true, recursive: true });
  }
}

// ---------------------------------------------------------------------------
// fs: files under CONTENT_DIR
// ---------------------------------------------------------------------------

export function objectPath(ownerId: string, sha256: string): string {
  return path.join(contentDir(), ownerId, sha256);
}

/**
 * Stream a body into the file store. The bytes go to a temporary file in the
 * owner's directory while being hashed and counted, and are published under
 * their hash only when the digest matches `sha256`. Returns the size in bytes.
 */
export async function writeObject(
  ownerId: string,
  sha256: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<number> {
  const dir = path.join(contentDir(), ownerId);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${sha256}.${randomBytes(6).toString("hex")}.part`);
  const hash = createHash("sha256");
  const limit = maxContentBytes();
  let size = 0;
  async function* meter(chunks: AsyncIterable<Buffer>) {
    for await (const chunk of chunks) {
      size += chunk.length;
      if (size > limit) {
        throw new ContentStoreError("too_large", `content exceeds the ${limit}-byte limit`);
      }
      hash.update(chunk);
      yield chunk;
    }
  }
  const source = body
    ? Readable.fromWeb(body as unknown as NodeWebReadableStream)
    : Readable.from([]);
  try {
    await pipeline(source, meter, createWriteStream(tmp, { flags: "wx" }));
    const digest = hash.digest("hex");
    if (digest !== sha256) {
      throw new ContentStoreError("hash_mismatch", `body hashes to ${digest}, not ${sha256}`);
    }
    await rename(tmp, objectPath(ownerId, sha256));
    return size;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Write held (already checked) bytes into the file store, under a temporary name first. */
export async function writeFileObject(ownerId: string, sha256: string, held: Held): Promise<void> {
  const dir = path.join(contentDir(), ownerId);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${sha256}.${randomBytes(6).toString("hex")}.part`);
  try {
    await (held.data
      ? writeFile(tmp, held.data, { flag: "wx" })
      : copyFile(held.file as string, tmp, constants.COPYFILE_EXCL));
    await rename(tmp, objectPath(ownerId, sha256));
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Is there a file for this object? */
export async function fileObjectExists(ownerId: string, sha256: string): Promise<boolean> {
  try {
    await stat(objectPath(ownerId, sha256));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * A stored file, checked against its hash before anything is returned: read
 * into memory when small, otherwise hashed in place and handed back as the
 * file itself.
 */
export async function readFileObject(ownerId: string, sha256: string): Promise<Held> {
  const file = objectPath(ownerId, sha256);
  try {
    const { size } = await stat(file);
    if (size <= MEMORY_BYTES) {
      return verifyBlob(sha256, await readFile(file));
    }
    const hash = createHash("sha256");
    const md5 = createHash("md5");
    const handle = await open(file);
    try {
      for await (const chunk of handle.createReadStream()) {
        hash.update(chunk as Buffer);
        md5.update(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
    if (hash.digest("hex") !== sha256) {
      throw new ContentStoreError("integrity", `stored content ${sha256} failed its hash check`);
    }
    return { file, md5: md5.digest("base64"), size, temporary: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ContentStoreError("missing", `no file for content ${sha256}`, { cause: error });
    }
    throw error;
  }
}

export async function deleteFileObject(ownerId: string, sha256: string): Promise<void> {
  await rm(objectPath(ownerId, sha256), { force: true });
}

// ---------------------------------------------------------------------------
// s3: an S3-compatible bucket
// ---------------------------------------------------------------------------

/** The object a configuration check writes once and reads back. */
const PROBE_KEY = "rl-content-store-probe";
const PROBE_BODY = Buffer.from("Reasoning Ledger content store probe\n");

let cachedClient: { key: string; client: S3Client } | undefined;

function bucketOf(config: ContentConfig = contentConfig()): { bucket: string; client: S3Client } {
  const settings = config.s3;
  if (!settings) {
    throw new ContentStoreError("config", "no object store is configured (CONTENT_S3_BUCKET)");
  }
  const key = JSON.stringify(settings);
  if (cachedClient?.key !== key) {
    cachedClient = {
      client: new S3Client({
        maxAttempts: 3,
        region: settings.region,
        // Content-MD5 checks every upload; the SDK's own default checksums are
        // not understood by every S3-compatible service.
        requestChecksumCalculation: "WHEN_REQUIRED",
        requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 },
        responseChecksumValidation: "WHEN_REQUIRED",
        ...(settings.endpoint && { endpoint: settings.endpoint, forcePathStyle: true }),
        ...(settings.accessKeyId &&
          settings.secretAccessKey && {
            credentials: {
              accessKeyId: settings.accessKeyId,
              secretAccessKey: settings.secretAccessKey,
            },
          }),
      }),
      key,
    };
  }
  return { bucket: settings.bucket, client: cachedClient.client };
}

export function s3Key(ownerId: string, sha256: string): string {
  return `${ownerId}/${sha256}`;
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode;
}

function describe(error: unknown): string {
  const status = statusOf(error);
  const name = error instanceof Error ? error.name : "error";
  const message = error instanceof Error ? error.message : String(error);
  return status ? `${name} (HTTP ${status}): ${message}` : `${name}: ${message}`;
}

function unavailable(message: string, error: unknown): ContentStoreError {
  return new ContentStoreError("unavailable", `${message}: ${describe(error)}`, { cause: error });
}

/**
 * Put held (already checked) bytes into the bucket. Every write is
 * conditional (`If-None-Match: *`): the key is the content's hash, so an
 * object already there holds the same bytes and counts as written, and a
 * bucket that refuses overwrites accepts these writes.
 */
export async function putS3Object(
  ownerId: string,
  sha256: string,
  held: Held,
  config?: ContentConfig,
): Promise<void> {
  const { bucket, client } = bucketOf(config);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.send(
        new PutObjectCommand({
          Body: held.data ?? createReadStream(held.file as string),
          Bucket: bucket,
          ContentLength: held.size,
          ContentMD5: held.md5,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          Key: s3Key(ownerId, sha256),
        }),
      );
      return;
    } catch (error) {
      const status = statusOf(error);
      if (status === 412) {
        return;
      }
      // Another write of the same key is in flight; once it lands this one answers 412.
      if (status === 409 && attempt < 4) {
        await sleep(150 * attempt);
        continue;
      }
      throw unavailable(`could not write content ${sha256} to bucket ${bucket}`, error);
    }
  }
}

/** An object from the bucket, checked against its hash before anything is returned. */
export async function getS3Object(
  ownerId: string,
  sha256: string,
  config?: ContentConfig,
): Promise<Held> {
  const { bucket, client } = bucketOf(config);
  let body: Readable;
  try {
    const out = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: s3Key(ownerId, sha256) }),
    );
    body = (out.Body as Readable | undefined) ?? Readable.from([]);
  } catch (error) {
    if (statusOf(error) === 404) {
      throw new ContentStoreError(
        "missing",
        `no object for content ${sha256} in bucket ${bucket}`,
        {
          cause: error,
        },
      );
    }
    throw unavailable(`could not read content ${sha256} from bucket ${bucket}`, error);
  }
  try {
    return await hold(body, { limit: Number.POSITIVE_INFINITY, mismatch: "integrity", sha256 });
  } catch (error) {
    if (error instanceof ContentStoreError) {
      throw error;
    }
    throw unavailable(`could not read content ${sha256} from bucket ${bucket}`, error);
  }
}

/** Is there an object for this content in the bucket? */
export async function s3ObjectExists(
  ownerId: string,
  sha256: string,
  config?: ContentConfig,
): Promise<boolean> {
  const { bucket, client } = bucketOf(config);
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: s3Key(ownerId, sha256) }));
    return true;
  } catch (error) {
    if (statusOf(error) === 404) {
      return false;
    }
    throw unavailable(`could not look for content ${sha256} in bucket ${bucket}`, error);
  }
}

/**
 * Delete an object from the bucket. A credential that may only add and read
 * objects (the one recommended for the server) gets ContentStoreError("denied").
 */
export async function deleteS3Object(
  ownerId: string,
  sha256: string,
  config?: ContentConfig,
): Promise<void> {
  const { bucket, client } = bucketOf(config);
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key(ownerId, sha256) }));
  } catch (error) {
    if (statusOf(error) === 403) {
      throw new ContentStoreError(
        "denied",
        `this credential may not delete objects from bucket ${bucket}`,
        { cause: error },
      );
    }
    throw unavailable(`could not delete content ${sha256} from bucket ${bucket}`, error);
  }
}

/**
 * Check that the configured bucket takes writes and returns them: writes a
 * small probe object once (later checks find it there) and reads it back.
 */
export async function probeObjectStore(config: ContentConfig = contentConfig()): Promise<string> {
  const { bucket, client } = bucketOf(config);
  try {
    await client.send(
      new PutObjectCommand({
        Body: PROBE_BODY,
        Bucket: bucket,
        ContentLength: PROBE_BODY.length,
        ContentMD5: createHash("md5").update(PROBE_BODY).digest("base64"),
        ContentType: "text/plain",
        IfNoneMatch: "*",
        Key: PROBE_KEY,
      }),
    );
  } catch (error) {
    if (statusOf(error) !== 412) {
      throw unavailable(`cannot write to bucket ${bucket}`, error);
    }
  }
  const chunks: Buffer[] = [];
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: PROBE_KEY }));
    for await (const chunk of (out.Body as Readable | undefined) ?? Readable.from([])) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
  } catch (error) {
    throw unavailable(`cannot read from bucket ${bucket}`, error);
  }
  if (!Buffer.concat(chunks).equals(PROBE_BODY)) {
    throw new ContentStoreError(
      "integrity",
      `bucket ${bucket} returned something else for ${PROBE_KEY}`,
    );
  }
  return `bucket ${bucket} takes writes and returns them`;
}
