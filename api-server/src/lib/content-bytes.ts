/**
 * The server's side of the content store (lib/content-store.ts): puts an
 * upload where `placement` says and records it, and reads an object back from
 * wherever its row says the bytes are.
 *
 * Objects kept in the database are rows of content_blobs, written in the same
 * transaction as their content_objects row. The runtime account can add those
 * rows but never change or delete them (prisma/grants.sql); the operator
 * commands delete and move them.
 */

import {
  ContentStoreError,
  FALLBACK_MAX_BYTES,
  bufferOf,
  contentConfig,
  getS3Object,
  isContentLocation,
  placement,
  putS3Object,
  readFileObject,
  receive,
  release,
  verifyBlob,
  writeFileObject,
  writeObject,
} from "#/lib/content-store";
import type { ContentLocation, Held } from "#/lib/content-store";
import { prisma } from "#/lib/prisma";

export interface StoredObject {
  owner_id: string;
  sha256: string;
  bytes: bigint;
  media_type: string;
  location: string;
  deleted_at: Date | null;
}

function recordRow(
  ownerId: string,
  sha256: string,
  bytes: number,
  mediaType: string,
  location: ContentLocation,
) {
  return prisma.contentObject.upsert({
    create: { bytes: BigInt(bytes), location, media_type: mediaType, owner_id: ownerId, sha256 },
    update: { bytes: BigInt(bytes), deleted_at: null, location, media_type: mediaType },
    where: { owner_id_sha256: { owner_id: ownerId, sha256 } },
  });
}

/**
 * Store an upload: checked against `sha256` and the size limit, then put where
 * `placement` says. When the object store refuses an object of at most
 * FALLBACK_MAX_BYTES, it is kept in the database instead, logged, and moved to
 * the bucket later by `content move`; a larger one fails the upload.
 */
export async function storeUpload(
  ownerId: string,
  sha256: string,
  body: ReadableStream<Uint8Array> | null,
  mediaType: string,
): Promise<StoredObject> {
  const config = contentConfig();
  if (config.store === "fs" && config.inlineMax === 0) {
    // Files only: streamed straight into the owner's directory, as always.
    const bytes = await writeObject(ownerId, sha256, body);
    return recordRow(ownerId, sha256, bytes, mediaType, "fs");
  }
  const held = await receive(sha256, body);
  try {
    let location = placement(held.size, config);
    if (location === "s3") {
      try {
        await putS3Object(ownerId, sha256, held, config);
      } catch (error) {
        if (held.size > FALLBACK_MAX_BYTES) {
          throw error;
        }
        console.warn(
          `content: kept ${sha256} (${held.size} bytes, owner ${ownerId}) in the database because the object store refused it; \`content move\` puts it in the bucket later. ${error instanceof Error ? error.message : String(error)}`,
        );
        location = "db";
      }
    } else if (location === "fs") {
      await writeFileObject(ownerId, sha256, held);
    }
    if (location === "db") {
      const data = new Uint8Array(await bufferOf(held));
      const [row] = await prisma.$transaction([
        recordRow(ownerId, sha256, held.size, mediaType, "db"),
        prisma.contentBlob.createMany({
          data: [{ data, owner_id: ownerId, sha256 }],
          skipDuplicates: true,
        }),
      ]);
      return row;
    }
    return await recordRow(ownerId, sha256, held.size, mediaType, location);
  } finally {
    await release(held);
  }
}

/** The bytes of a stored object, from wherever its row says they are, checked against the hash. */
export async function readStored(row: {
  owner_id: string;
  sha256: string;
  location: string;
}): Promise<Held> {
  const location = isContentLocation(row.location) ? row.location : "fs";
  if (location === "db") {
    const blob = await prisma.contentBlob.findUnique({
      select: { data: true },
      where: { owner_id_sha256: { owner_id: row.owner_id, sha256: row.sha256 } },
    });
    if (!blob) {
      throw new ContentStoreError("missing", `no database copy of content ${row.sha256}`);
    }
    return verifyBlob(row.sha256, blob.data);
  }
  if (location === "s3") {
    return getS3Object(row.owner_id, row.sha256);
  }
  return readFileObject(row.owner_id, row.sha256);
}

/**
 * The bytes of several objects of one owner, read where each row says, for a
 * viewer page: the database copies in one query. Each entry is the bytes or
 * the ContentStoreError that kept them from being read.
 */
export async function readStoredMany(
  ownerId: string,
  rows: { sha256: string; location: string }[],
): Promise<Map<string, Buffer | ContentStoreError>> {
  const inDb = rows.filter((row) => row.location === "db").map((row) => row.sha256);
  const blobs = new Map<string, Uint8Array>();
  if (inDb.length > 0) {
    const found = await prisma.contentBlob.findMany({
      select: { data: true, sha256: true },
      where: { owner_id: ownerId, sha256: { in: inDb } },
    });
    for (const blob of found) {
      blobs.set(blob.sha256, blob.data);
    }
  }
  const results = await Promise.all(
    rows.map(async (row): Promise<[string, Buffer | ContentStoreError]> => {
      try {
        let held: Held;
        if (row.location === "db") {
          const data = blobs.get(row.sha256);
          if (!data) {
            throw new ContentStoreError("missing", `no database copy of content ${row.sha256}`);
          }
          held = verifyBlob(row.sha256, data);
        } else {
          held = await readStored({ ...row, owner_id: ownerId });
        }
        try {
          return [row.sha256, await bufferOf(held)];
        } finally {
          await release(held);
        }
      } catch (error) {
        if (error instanceof ContentStoreError) {
          return [row.sha256, error];
        }
        throw error;
      }
    }),
  );
  return new Map(results);
}
