/**
 * Content for the trace viewer (design §4.3). A page reads the content its
 * records reference as the signed-in owner, from that owner's namespace only.
 * Text and JSON up to DISPLAY_LIMIT are shown inline; anything else is
 * described by its reference.
 *
 * Encrypted content (ContentRef.enc) is not opened here: the server has no
 * key. The page gets the ciphertext and the wrapped data key, and the browser
 * decrypts with the master key it was given through the sign-in link's
 * fragment (scripts/decrypt.ts), which never reaches the server.
 */

import { readStoredMany } from "#/lib/content-bytes";
import { contentKeysByIds } from "#/lib/content-keys";
import { contentRefsOf } from "#/lib/content-refs";
import type { ContentRef } from "#/lib/content-refs";
import type { ContentStoreError } from "#/lib/content-store";
import { SHA256_HEX } from "#/lib/content-store";
import { prisma } from "#/lib/prisma";
import type { ContentMap, ContentView } from "#/lib/trace";

const DISPLAY_LIMIT = 256 * 1024;

interface StoredObject {
  bytes: bigint;
  deleted_at: Date | null;
  media_type: string;
  location: string;
}

/** The bytes the page may show, read beforehand: each one's bytes, or why they could not be read. */
type ReadBytes = Map<string, Buffer | ContentStoreError>;

/** Whether a stored object's bytes are read for the page at all. */
function shown(stored: StoredObject | undefined): stored is StoredObject {
  return Boolean(stored && !stored.deleted_at && Number(stored.bytes) <= DISPLAY_LIMIT);
}

function isJson(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

function isText(mediaType: string): boolean {
  return mediaType.trim().toLowerCase().startsWith("text/") || isJson(mediaType);
}

/** The stored bytes, or the view state that says why they cannot be shown. */
function storedBytes(
  sha256: string,
  stored: StoredObject | undefined,
  read: ReadBytes,
): Buffer | ContentView {
  if (!stored) {
    return { state: "missing" };
  }
  if (stored.deleted_at) {
    return { state: "deleted" };
  }
  if (Number(stored.bytes) > DISPLAY_LIMIT) {
    return { state: "too_large" };
  }
  const data = read.get(sha256);
  if (Buffer.isBuffer(data)) {
    return data;
  }
  switch (data?.kind) {
    case "missing": {
      return { state: "missing" };
    }
    case "unavailable": {
      return { state: "unavailable" };
    }
    default: {
      return { state: "unreadable" };
    }
  }
}

function viewOf(ref: ContentRef, stored: StoredObject | undefined, read: ReadBytes): ContentView {
  if (ref.enc) {
    const data = storedBytes(ref.sha256, stored, read);
    if (!Buffer.isBuffer(data)) {
      return data;
    }
    return {
      alg: ref.enc.alg,
      bytes: ref.enc.plaintext_bytes,
      ciphertext: data.toString("base64"),
      key_id: ref.enc.key_id,
      media_type: ref.enc.plaintext_media_type,
      state: "encrypted",
    };
  }
  if (stored && !stored.deleted_at && !isText(stored.media_type)) {
    return { state: "binary" };
  }
  const data = storedBytes(ref.sha256, stored, read);
  if (!Buffer.isBuffer(data)) {
    return data;
  }
  const text = data.toString("utf-8");
  if (stored && isJson(stored.media_type)) {
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
  // One reference per hash; the first that says the bytes are encrypted wins,
  // since the same bytes cannot be both.
  const refs = new Map<string, ContentRef>();
  for (const ref of records.flatMap(contentRefsOf)) {
    if (!SHA256_HEX.test(ref.sha256)) {
      continue;
    }
    const seen = refs.get(ref.sha256);
    if (!seen || (!seen.enc && ref.enc)) {
      refs.set(ref.sha256, ref);
    }
  }
  if (refs.size === 0) {
    return {};
  }
  const rows = await prisma.contentObject.findMany({
    select: { bytes: true, deleted_at: true, location: true, media_type: true, sha256: true },
    where: { owner_id: ownerId, sha256: { in: [...refs.keys()] } },
  });
  const byHash = new Map(rows.map((row) => [row.sha256, row]));
  const entries = [...refs.values()];
  // Only what the page shows is read: not binary unencrypted content, nothing deleted or too large.
  const wanted = entries
    .map((ref) => ({ ref, stored: byHash.get(ref.sha256) }))
    .filter(({ ref, stored }) => shown(stored) && (Boolean(ref.enc) || isText(stored.media_type)))
    .map(({ stored }) => stored as StoredObject & { sha256: string });
  const read = await readStoredMany(ownerId, wanted);
  return Object.fromEntries(
    entries.map((ref) => [ref.sha256, viewOf(ref, byHash.get(ref.sha256), read)]),
  );
}

/** What the browser needs to decrypt a page: its encrypted objects and their wrapped keys. */
export interface PageEncryption {
  objects: Record<
    string,
    { alg: string; bytes: number; ciphertext: string; key_id: string; media_type: string }
  >;
  keys: Record<string, { master_key_id: string; wrap_alg: string; wrapped_key: string }>;
}

/**
 * The encrypted objects of a content map, with the wrapped keys that open them:
 * the owner's, or for a viewer who came with a view grant, the grant's
 * (wrapped under the key their link carried) and no others.
 */
export async function encryptionForViewer(
  ownerId: string,
  contents: ContentMap,
  grantKeys?: PageEncryption["keys"],
): Promise<PageEncryption> {
  const objects: PageEncryption["objects"] = {};
  for (const [sha256, view] of Object.entries(contents)) {
    if (view.state === "encrypted") {
      const { state: _state, ...object } = view;
      objects[sha256] = object;
    }
  }
  const keyIds = [...new Set(Object.values(objects).map((object) => object.key_id))];
  const keys: PageEncryption["keys"] = {};
  if (grantKeys) {
    for (const keyId of keyIds) {
      if (grantKeys[keyId]) {
        keys[keyId] = grantKeys[keyId];
      }
    }
    return { keys, objects };
  }
  const rows = await contentKeysByIds(ownerId, keyIds);
  for (const [keyId, row] of rows) {
    keys[keyId] = {
      master_key_id: row.master_key_id,
      wrap_alg: row.wrap_alg,
      wrapped_key: row.wrapped_key,
    };
  }
  return { keys, objects };
}

/** JSON for a `<script type="application/json">`: nothing in it can close the element. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}
