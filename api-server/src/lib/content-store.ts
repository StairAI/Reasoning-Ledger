/**
 * Content store (design §3): raw bytes addressed by SHA-256, one namespace per
 * owner, kept on the local filesystem under CONTENT_DIR. The content_objects
 * table is the source of truth for ownership and deletion state; this module
 * only moves bytes.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { ReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";

export const SHA256_HEX = /^[0-9a-f]{64}$/;

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export type ContentStoreErrorKind = "too_large" | "hash_mismatch" | "integrity";

export class ContentStoreError extends Error {
  readonly kind: ContentStoreErrorKind;

  constructor(kind: ContentStoreErrorKind, message: string) {
    super(message);
    this.name = "ContentStoreError";
    this.kind = kind;
  }
}

/** Root directory of the store: CONTENT_DIR, else ./data/content under the working directory. */
export function contentDir(): string {
  return path.resolve(process.env.CONTENT_DIR ?? "data/content");
}

/** Largest accepted object in bytes: CONTENT_MAX_BYTES, else 64 MiB. */
export function maxContentBytes(): number {
  const configured = Number(process.env.CONTENT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

export function objectPath(ownerId: string, sha256: string): string {
  return path.join(contentDir(), ownerId, sha256);
}

/**
 * Stream a body into the store. The bytes go to a temporary file while being
 * hashed and counted, and are published under their hash only when the digest
 * matches `sha256`. Returns the size in bytes.
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

/**
 * Check a stored object against its hash before anything is returned, then
 * hand back a way to stream it. Throws ContentStoreError("integrity") on mismatch.
 */
export async function verifiedObject(
  ownerId: string,
  sha256: string,
): Promise<{ size: number; open: () => ReadStream }> {
  const file = objectPath(ownerId, sha256);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  if (hash.digest("hex") !== sha256) {
    throw new ContentStoreError("integrity", `stored content ${sha256} failed its hash check`);
  }
  const { size } = await stat(file);
  return { open: () => createReadStream(file), size };
}

/** Read a whole (small) object into memory, checked against its hash. */
export async function readVerified(ownerId: string, sha256: string): Promise<Buffer> {
  const data = await readFile(objectPath(ownerId, sha256));
  if (createHash("sha256").update(data).digest("hex") !== sha256) {
    throw new ContentStoreError("integrity", `stored content ${sha256} failed its hash check`);
  }
  return data;
}

export async function deleteObject(ownerId: string, sha256: string): Promise<void> {
  await rm(objectPath(ownerId, sha256), { force: true });
}
