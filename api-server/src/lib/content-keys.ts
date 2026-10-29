/**
 * Wrapped data keys (content encryption, 2.0).
 *
 * Content is encrypted on the writer's machine before it is uploaded: with a
 * data key, one per session, which is itself wrapped with the owner's master
 * key. The wrapped copy is registered here under a key id the writer chose,
 * and ContentRef.enc.key_id names it. The server keeps the wrapped key and
 * hands it to readers of the owner's content; the master key never leaves the
 * owner's machines, so the server cannot open anything it holds.
 *
 * Rotating the master key means re-wrapping every data key: a writer PUTs
 * each key id again with the new wrapped copy and master_key_id.
 */

import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";

export const WRAP_ALGS = ["A256GCM"] as const;
export type WrapAlg = (typeof WRAP_ALGS)[number];

/** Size of a wrapped key per algorithm: nonce (12) + the 32-byte data key + tag (16). */
const WRAPPED_BYTES: Record<WrapAlg, number> = { A256GCM: 60 };

export const KeyId = z.string().min(1).max(128);
export const MasterKeyId = z.string().regex(/^[0-9a-f]{16}$/, "16 lowercase hex characters");

export const ContentKeyBody = z.object({
  /** The agent whose session the key belongs to; must be this owner's. */
  agent_id: z.string().uuid().optional(),
  /** Which master key wrapped it: the first 16 hex characters of SHA-256(master key). */
  master_key_id: MasterKeyId,
  session_id: z.string().min(1).max(256).optional(),
  wrap_alg: z.enum(WRAP_ALGS),
  /** nonce + ciphertext + tag, base64. */
  wrapped_key: z.string().min(1).max(512),
});
export type ContentKeyBody = z.infer<typeof ContentKeyBody>;

export const ContentKeyView = z.object({
  agent_id: z.string().nullable(),
  created_at: z.number(),
  key_id: z.string(),
  master_key_id: z.string(),
  owner_id: z.string(),
  session_id: z.string().nullable(),
  updated_at: z.number(),
  wrap_alg: z.string(),
  wrapped_key: z.string(),
});
export type ContentKeyView = z.infer<typeof ContentKeyView>;

export interface ContentKeyRow {
  owner_id: string;
  key_id: string;
  agent_id: string | null;
  session_id: string | null;
  wrap_alg: string;
  master_key_id: string;
  wrapped_key: string;
  created_at: Date;
  updated_at: Date;
}

export function contentKeyView(row: ContentKeyRow): ContentKeyView {
  return {
    agent_id: row.agent_id,
    created_at: row.created_at.getTime(),
    key_id: row.key_id,
    master_key_id: row.master_key_id,
    owner_id: row.owner_id,
    session_id: row.session_id,
    updated_at: row.updated_at.getTime(),
    wrap_alg: row.wrap_alg,
    wrapped_key: row.wrapped_key,
  };
}

/** The wrapped key must be canonical base64 of exactly the algorithm's size. */
export function assertWrappedKey(body: Pick<ContentKeyBody, "wrap_alg" | "wrapped_key">): void {
  const decoded = Buffer.from(body.wrapped_key, "base64");
  const expected = WRAPPED_BYTES[body.wrap_alg];
  if (decoded.length !== expected || decoded.toString("base64") !== body.wrapped_key) {
    throw new ORPCError("BAD_REQUEST", {
      message: `wrapped_key must be base64 of ${expected} bytes for ${body.wrap_alg} (nonce, wrapped key, tag)`,
    });
  }
}

/** Register a wrapped key, or replace the wrapped copy under an existing key id (re-wrap). */
export async function registerContentKey(
  ownerId: string,
  keyId: string,
  body: ContentKeyBody,
): Promise<{ key: ContentKeyView; created: boolean }> {
  assertWrappedKey(body);
  if (body.agent_id) {
    const agent = await prisma.agent.findFirst({
      select: { id: true },
      where: { id: body.agent_id, owner_id: ownerId },
    });
    if (!agent) {
      throw new ORPCError("BAD_REQUEST", { message: "agent_id does not belong to this owner" });
    }
  }
  const where = { owner_id_key_id: { key_id: keyId, owner_id: ownerId } };
  const data = {
    agent_id: body.agent_id ?? null,
    master_key_id: body.master_key_id,
    session_id: body.session_id ?? null,
    wrap_alg: body.wrap_alg,
    wrapped_key: body.wrapped_key,
  };
  const existing = await prisma.contentKey.findUnique({ where });
  const row = existing
    ? await prisma.contentKey.update({ data, where })
    : await prisma.contentKey.create({ data: { ...data, key_id: keyId, owner_id: ownerId } });
  return { created: !existing, key: contentKeyView(row) };
}

/** One key of an owner; for the administrator (ownerId null), whichever owner holds that key id. */
export function ownedContentKey(
  ownerId: string | null,
  keyId: string,
): Promise<ContentKeyRow | null> {
  if (ownerId === null) {
    return prisma.contentKey.findFirst({
      orderBy: { created_at: "asc" },
      where: { key_id: keyId },
    });
  }
  return prisma.contentKey.findUnique({
    where: { owner_id_key_id: { key_id: keyId, owner_id: ownerId } },
  });
}

export interface ContentKeyFilter {
  agent_id?: string;
  session_id?: string;
  /** Keys after this key id, in key id order. */
  after?: string;
  limit: number;
  /** For the administrator: narrow to one owner. */
  owner_id?: string;
}

/** A page of an owner's keys in key id order; the administrator reads across owners. */
export async function ownedContentKeys(
  ownerId: string | null,
  filter: ContentKeyFilter,
): Promise<{ keys: ContentKeyRow[]; next_after: string | null }> {
  const rows = await prisma.contentKey.findMany({
    orderBy: [{ owner_id: "asc" }, { key_id: "asc" }],
    take: filter.limit + 1,
    where: {
      ...(filter.after ? { key_id: { gt: filter.after } } : {}),
      ...(filter.agent_id ? { agent_id: filter.agent_id } : {}),
      ...(filter.session_id ? { session_id: filter.session_id } : {}),
      owner_id: ownerId ?? filter.owner_id,
    },
  });
  const page = rows.slice(0, filter.limit);
  return {
    keys: page,
    next_after: rows.length > filter.limit ? (page.at(-1)?.key_id ?? null) : null,
  };
}

/** The owner's wrapped keys for these key ids, by key id. */
export async function contentKeysByIds(
  ownerId: string,
  keyIds: string[],
): Promise<Map<string, ContentKeyRow>> {
  if (keyIds.length === 0) {
    return new Map();
  }
  const rows = await prisma.contentKey.findMany({
    where: { key_id: { in: [...new Set(keyIds)] }, owner_id: ownerId },
  });
  return new Map(rows.map((row) => [row.key_id, row]));
}
