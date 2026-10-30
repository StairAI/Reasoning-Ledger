/**
 * View grants: a time-limited authorization to read some of an owner's sessions
 * in the trace viewer. A view is one authorized decryption.
 *
 * The owner's machine picks the sessions, unwraps their data keys with the
 * master key, wraps them again with a fresh grant key and registers the
 * re-wrapped copies here (POST /v1/view-grants). The link it opens,
 * /session/grant/{token}#k={grant key}, carries the grant key in its fragment,
 * which the browser never sends; the viewer pages give the browser the
 * re-wrapped keys, and scripts/decrypt.ts opens them with the grant key as it
 * would with a master key. The master key never leaves the owner's machine,
 * and the server, holding only keys wrapped under a key it never sees, still
 * cannot read the content.
 *
 * A grant ends when it expires or is revoked: its keys are dropped and its
 * viewer sessions go with it, so a grant key left in a browser's history opens
 * nothing afterwards.
 */

import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { Prisma } from "#/generated/prisma/client";
import { contentKeysByIds } from "#/lib/content-keys";
import { prisma } from "#/lib/prisma";

export const GRANT_PATH = "/session/grant/";
export const GRANT_DEFAULT_SECONDS = 60 * 60;
export const GRANT_MAX_SECONDS = 24 * 60 * 60;
export const GRANT_MAX_KEYS = 5000;

/** A data key wrapped under a grant key: the shape scripts/decrypt.ts reads. */
export interface WrappedKey {
  master_key_id: string;
  wrap_alg: string;
  wrapped_key: string;
}
export type GrantKeys = Record<string, WrappedKey>;

export interface GrantKeyInput extends WrappedKey {
  key_id: string;
}

/** A grant that is in force: not expired, not revoked. */
export interface ActiveGrant {
  id: string;
  ownerId: string;
  sessionIds: Set<string>;
  keys: GrantKeys;
  expiresAt: Date;
}

export interface GrantSummary {
  created_at: number;
  ended_at: number | null;
  expires_at: number;
  grant_id: string;
  purpose: string;
  revoked_at: number | null;
  sessions: number;
}

export function hashGrantToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Drop the keys of every grant that has expired: called whenever grants are made, opened or listed. */
async function dropExpiredKeys(now: Date): Promise<void> {
  await prisma.viewGrant.updateMany({
    data: { ended_at: now, keys: {} },
    where: { ended_at: null, expires_at: { lte: now } },
  });
}

function badRequest(message: string): ORPCError<"BAD_REQUEST", unknown> {
  return new ORPCError("BAD_REQUEST", { message });
}

/**
 * Register a grant: every key must be one of the owner's data keys, wrapped
 * under one grant key that is not the master key that wrapped the owner's copy.
 * The sessions it opens are those the server has for those keys, not whatever
 * the caller says.
 */
export async function createViewGrant(
  ownerId: string,
  input: { keys: GrantKeyInput[]; expires_in?: number; purpose?: string },
): Promise<{ id: string; token: string; expiresAt: Date; sessions: number }> {
  const now = new Date();
  await dropExpiredKeys(now);
  const ids = input.keys.map((key) => key.key_id);
  if (ids.length === 0 || ids.length > GRANT_MAX_KEYS) {
    throw badRequest(`A grant carries between 1 and ${GRANT_MAX_KEYS} keys`);
  }
  if (new Set(ids).size !== ids.length) {
    throw badRequest("Each key_id appears once");
  }
  const grantKeyIds = new Set(input.keys.map((key) => key.master_key_id));
  if (grantKeyIds.size !== 1) {
    throw badRequest("Every key is wrapped under the same grant key");
  }
  const [grantKeyId] = grantKeyIds;
  const owned = await contentKeysByIds(ownerId, ids);
  const missing = ids.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    throw badRequest(`Not your content keys: ${missing.slice(0, 3).join(", ")}`);
  }
  if ([...owned.values()].some((row) => row.master_key_id === grantKeyId)) {
    throw badRequest("Wrap the keys under a fresh grant key, not the master key");
  }
  const sessionIds = [
    ...new Set([...owned.values()].flatMap((row) => (row.session_id ? [row.session_id] : []))),
  ];
  const seconds = Math.min(
    Math.max(Math.trunc(input.expires_in ?? GRANT_DEFAULT_SECONDS), 60),
    GRANT_MAX_SECONDS,
  );
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + seconds * 1000);
  const keys: GrantKeys = Object.fromEntries(
    input.keys.map((key) => [
      key.key_id,
      { master_key_id: key.master_key_id, wrap_alg: key.wrap_alg, wrapped_key: key.wrapped_key },
    ]),
  );
  const row = await prisma.viewGrant.create({
    data: {
      expires_at: expiresAt,
      keys: keys as unknown as Prisma.InputJsonObject,
      owner_id: ownerId,
      purpose: input.purpose ?? "view",
      session_ids: sessionIds,
      token_hash: hashGrantToken(token),
    },
  });
  return { expiresAt, id: row.id, sessions: sessionIds.length, token };
}

type GrantRow = Awaited<ReturnType<typeof prisma.viewGrant.findUnique>>;

function inForce(row: GrantRow, now: Date): ActiveGrant | null {
  if (!row || row.revoked_at || row.ended_at || row.expires_at.getTime() <= now.getTime()) {
    return null;
  }
  return {
    expiresAt: row.expires_at,
    id: row.id,
    keys: row.keys as unknown as GrantKeys,
    ownerId: row.owner_id,
    sessionIds: new Set(row.session_ids),
  };
}

/** The grant a link token names, when it is in force. */
export async function grantForToken(token: string | undefined): Promise<ActiveGrant | null> {
  if (!token || token.length > 128) {
    return null;
  }
  const now = new Date();
  await dropExpiredKeys(now);
  return inForce(
    await prisma.viewGrant.findUnique({ where: { token_hash: hashGrantToken(token) } }),
    now,
  );
}

/** A grant by id, when it is in force (a viewer session's grant). */
export async function activeGrant(id: string): Promise<ActiveGrant | null> {
  return inForce(await prisma.viewGrant.findUnique({ where: { id } }), new Date());
}

/** The owner's grants, newest first, without their keys. */
export async function listViewGrants(ownerId: string): Promise<GrantSummary[]> {
  await dropExpiredKeys(new Date());
  const rows = await prisma.viewGrant.findMany({
    orderBy: { created_at: "desc" },
    select: {
      created_at: true,
      ended_at: true,
      expires_at: true,
      id: true,
      purpose: true,
      revoked_at: true,
      session_ids: true,
    },
    take: 100,
    where: { owner_id: ownerId },
  });
  return rows.map((row) => ({
    created_at: row.created_at.getTime(),
    ended_at: row.ended_at?.getTime() ?? null,
    expires_at: row.expires_at.getTime(),
    grant_id: row.id,
    purpose: row.purpose,
    revoked_at: row.revoked_at?.getTime() ?? null,
    sessions: row.session_ids.length,
  }));
}

/** End a grant now: drop its keys and sign out every browser it opened. False when the owner has no such grant. */
export async function revokeViewGrant(ownerId: string, id: string): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.viewGrant.updateMany({
    data: { ended_at: now, keys: {}, revoked_at: now },
    where: { id, owner_id: ownerId, revoked_at: null },
  });
  await prisma.vizSession.deleteMany({ where: { grant_id: id } });
  return count > 0;
}

/** Whether a viewer may see a session: always, unless their session came from a grant that does not name it. */
export function grantAllows(
  grant: { sessionIds: Set<string> } | undefined,
  sessionId: string,
): boolean {
  return !grant || grant.sessionIds.has(sessionId);
}
