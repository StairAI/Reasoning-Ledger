/**
 * Content for the trace viewer (design §4.3). A page reads the content its
 * records reference as the signed-in owner, from that owner's namespace only.
 * Text and JSON up to DISPLAY_LIMIT are shown inline; anything else is
 * described by its reference.
 */

import { contentRefsOf } from "#/lib/content-refs";
import { ContentStoreError, SHA256_HEX, readVerified } from "#/lib/content-store";
import { prisma } from "#/lib/prisma";
import type { ContentMap, ContentView } from "#/lib/trace";

const DISPLAY_LIMIT = 256 * 1024;

interface StoredObject {
  bytes: bigint;
  deleted_at: Date | null;
  media_type: string;
}

function isJson(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

function isText(mediaType: string): boolean {
  return mediaType.trim().toLowerCase().startsWith("text/") || isJson(mediaType);
}

async function viewOf(
  ownerId: string,
  sha256: string,
  stored: StoredObject | undefined,
): Promise<ContentView> {
  if (!stored) {
    return { state: "missing" };
  }
  if (stored.deleted_at) {
    return { state: "deleted" };
  }
  if (!isText(stored.media_type)) {
    return { state: "binary" };
  }
  if (Number(stored.bytes) > DISPLAY_LIMIT) {
    return { state: "too_large" };
  }
  let data: Buffer;
  try {
    data = await readVerified(ownerId, sha256);
  } catch (error) {
    if (error instanceof ContentStoreError) {
      return { state: "unreadable" };
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
    throw error;
  }
  const text = data.toString("utf-8");
  if (isJson(stored.media_type)) {
    try {
      return { state: "json", value: JSON.parse(text) as unknown };
    } catch {
      // Not valid JSON after all: show it as text.
    }
  }
  return { state: "text", text };
}

/** Resolve, as `ownerId`, every content reference that `records` carry. */
export async function contentForViewer(
  ownerId: string,
  records: Record<string, unknown>[],
): Promise<ContentMap> {
  const hashes = [
    ...new Set(
      records
        .flatMap(contentRefsOf)
        .map((ref) => ref.sha256)
        .filter((sha256) => SHA256_HEX.test(sha256)),
    ),
  ];
  if (hashes.length === 0) {
    return {};
  }
  const rows = await prisma.contentObject.findMany({
    select: { bytes: true, deleted_at: true, media_type: true, sha256: true },
    where: { owner_id: ownerId, sha256: { in: hashes } },
  });
  const byHash = new Map(rows.map((row) => [row.sha256, row]));
  const views = await Promise.all(
    hashes.map((sha256) => viewOf(ownerId, sha256, byHash.get(sha256))),
  );
  return Object.fromEntries(hashes.map((sha256, i) => [sha256, views[i]]));
}
