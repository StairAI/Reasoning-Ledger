/**
 * Content library (design §3). Raw bytes, not JSON, so these endpoints sit
 * beside the oRPC handler rather than inside it.
 *
 *   PUT  /v1/content/{sha256}   upload; the server checks the hash; already stored → 200
 *   HEAD /v1/content/{sha256}   does this owner hold the content?
 *   GET  /v1/content/{sha256}   read this owner's content
 *
 * All three need X-API-Key and only see the caller's own namespace: another
 * owner's content answers 404, deleted content answers 410. Reads also accept
 * the administrator's token, which sees every owner's content (lib/admin.ts).
 *
 * The bytes go where the content store places them (lib/content-store.ts) and
 * are read from wherever their row says they are. An object store that cannot
 * be reached answers 503; bytes that are gone or fail their hash check, 500.
 */

import type { APIRoute } from "astro";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { isAdminToken, logAdminRead } from "#/lib/admin";
import { ownerForApiKey } from "#/lib/auth";
import { readStored, storeUpload } from "#/lib/content-bytes";
import { ContentStoreError, SHA256_HEX, openHeld, release } from "#/lib/content-store";
import type { Held } from "#/lib/content-store";
import { prisma } from "#/lib/prisma";

export const prerender = false;

function fail(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

async function caller(
  request: Request,
  sha256: string | undefined,
): Promise<{ ownerId: string; sha256: string } | Response> {
  const key = request.headers.get("x-api-key");
  if (!key) {
    return fail(401, "Missing X-API-Key header");
  }
  const owner = await ownerForApiKey(key);
  if (!owner) {
    return fail(401, "Invalid API key");
  }
  if (!sha256 || !SHA256_HEX.test(sha256)) {
    return fail(400, "sha256 must be 64 lowercase hex characters");
  }
  return { ownerId: owner.ownerId, sha256 };
}

function stored(ownerId: string, sha256: string) {
  return prisma.contentObject.findUnique({
    where: { owner_id_sha256: { owner_id: ownerId, sha256 } },
  });
}

function ref(row: { sha256: string; bytes: bigint; media_type: string }) {
  return { bytes: Number(row.bytes), media_type: row.media_type, sha256: row.sha256 };
}

export const PUT: APIRoute = async ({ request, params }) => {
  const who = await caller(request, params.sha256);
  if (who instanceof Response) {
    return who;
  }
  const { ownerId, sha256 } = who;

  const existing = await stored(ownerId, sha256);
  if (existing && !existing.deleted_at) {
    await request.body?.cancel();
    return Response.json(ref(existing), { status: 200 });
  }

  const mediaType = request.headers.get("content-type") ?? "application/octet-stream";
  try {
    const row = await storeUpload(ownerId, sha256, request.body, mediaType);
    return Response.json(ref(row), { status: 201 });
  } catch (error) {
    if (error instanceof ContentStoreError && error.kind === "too_large") {
      return fail(413, error.message);
    }
    if (error instanceof ContentStoreError && error.kind === "hash_mismatch") {
      return fail(400, error.message);
    }
    if (error instanceof ContentStoreError && error.kind === "unavailable") {
      console.error(`content: upload of ${sha256} failed: ${error.message}`);
      return fail(503, "Content storage is unavailable; try again later");
    }
    throw error;
  }
};

/**
 * Whose namespace to read from: the caller's own, or — for the administrator —
 * whichever owner holds this content. Content is addressed by hash, so every
 * copy has the same bytes.
 */
async function readFrom(
  request: Request,
  sha256: string | undefined,
): Promise<{ ownerId: string; sha256: string } | Response> {
  if (!isAdminToken(request.headers.get("x-admin-token"))) {
    return caller(request, sha256);
  }
  if (!sha256 || !SHA256_HEX.test(sha256)) {
    return fail(400, "sha256 must be 64 lowercase hex characters");
  }
  const row = await prisma.contentObject.findFirst({
    orderBy: { deleted_at: { nulls: "first", sort: "asc" } },
    where: { sha256 },
  });
  if (!row) {
    return fail(404, "Content not found");
  }
  logAdminRead("content", { owner_id: row.owner_id, sha256 });
  return { ownerId: row.owner_id, sha256 };
}

async function read(request: Request, sha256: string | undefined, withBody: boolean) {
  const who = await readFrom(request, sha256);
  if (who instanceof Response) {
    return who;
  }
  const row = await stored(who.ownerId, who.sha256);
  if (!row) {
    return fail(404, "Content not found");
  }
  if (row.deleted_at) {
    return fail(410, "Content was deleted");
  }

  let held: Held;
  try {
    held = await readStored(row);
  } catch (error) {
    if (error instanceof ContentStoreError && error.kind === "unavailable") {
      console.error(`content: read of ${row.sha256} failed: ${error.message}`);
      return fail(503, "Content storage is unavailable; try again later");
    }
    if (error instanceof ContentStoreError) {
      return fail(500, error.message);
    }
    throw error;
  }

  const headers = {
    "content-length": String(held.size),
    "content-type": row.media_type,
    etag: `"${row.sha256}"`,
  };
  if (!withBody) {
    await release(held);
    return new Response(null, { headers, status: 200 });
  }
  const stream = openHeld(held);
  stream.once("close", () => {
    void release(held);
  });
  const body = Readable.toWeb(stream) as unknown as NodeWebReadableStream;
  return new Response(body as unknown as ReadableStream, { headers, status: 200 });
}

export const HEAD: APIRoute = ({ request, params }) => read(request, params.sha256, false);

export const GET: APIRoute = ({ request, params }) => read(request, params.sha256, true);
