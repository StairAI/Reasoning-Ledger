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
 */

import type { APIRoute } from "astro";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { isAdminToken, logAdminRead } from "#/lib/admin";
import { ownerForApiKey } from "#/lib/auth";
import { ContentStoreError, SHA256_HEX, verifiedObject, writeObject } from "#/lib/content-store";
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

  let bytes: number;
  try {
    bytes = await writeObject(ownerId, sha256, request.body);
  } catch (error) {
    if (error instanceof ContentStoreError && error.kind === "too_large") {
      return fail(413, error.message);
    }
    if (error instanceof ContentStoreError && error.kind === "hash_mismatch") {
      return fail(400, error.message);
    }
    throw error;
  }

  const mediaType = request.headers.get("content-type") ?? "application/octet-stream";
  const row = await prisma.contentObject.upsert({
    create: { bytes: BigInt(bytes), media_type: mediaType, owner_id: ownerId, sha256 },
    update: { bytes: BigInt(bytes), deleted_at: null, media_type: mediaType },
    where: { owner_id_sha256: { owner_id: ownerId, sha256 } },
  });
  return Response.json(ref(row), { status: 201 });
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

  let object: Awaited<ReturnType<typeof verifiedObject>>;
  try {
    object = await verifiedObject(who.ownerId, who.sha256);
  } catch (error) {
    if (error instanceof ContentStoreError && error.kind === "integrity") {
      return fail(500, error.message);
    }
    throw error;
  }

  const headers = {
    "content-length": String(object.size),
    "content-type": row.media_type,
    etag: `"${row.sha256}"`,
  };
  if (!withBody) {
    return new Response(null, { headers, status: 200 });
  }
  const body = Readable.toWeb(object.open()) as unknown as NodeWebReadableStream;
  return new Response(body as unknown as ReadableStream, { headers, status: 200 });
}

export const HEAD: APIRoute = ({ request, params }) => read(request, params.sha256, false);

export const GET: APIRoute = ({ request, params }) => read(request, params.sha256, true);
