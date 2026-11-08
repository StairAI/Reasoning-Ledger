/**
 * Invite codes (registration policy `invite`, lib/registration.ts).
 *
 * An operator makes codes with the administrator token, or hands that job to
 * an application with the invites token (lib/admin.ts); a person registering
 * through the plugin passes one, and it stays recorded on the owner it
 * admitted. A code has a number of uses, may expire, and can be revoked; its
 * note, saying who it is for, can be changed at any time. The policy is a
 * switch: set RL_REGISTRATION=open and codes are no longer asked for, while
 * the table and the attribution stay.
 */

import { randomInt } from "node:crypto";
import { ORPCError } from "@orpc/server";
import * as z from "zod";
import type { Prisma } from "#/generated/prisma/client";
import { prisma } from "#/lib/prisma";

/** Letters and digits that are not mistaken for one another when read aloud or typed. */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const GROUPS = 2;
const GROUP_LENGTH = 5;

export const InviteCode = z.string().min(1).max(64);

/** A code as handed out: STAIR-XXXXX-XXXXX. */
export function generateInviteCode(): string {
  const group = () =>
    Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return `STAIR-${Array.from({ length: GROUPS }, group).join("-")}`;
}

/** Codes are compared without case or surrounding space. */
export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase();
}

export interface InviteRow {
  code: string;
  note: string | null;
  max_uses: number;
  uses: number;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

/** An owner a code admitted: `created_at` is when it registered, in milliseconds. */
export const InviteOwner = z.object({
  created_at: z.number(),
  email: z.string().nullable(),
  owner_id: z.string(),
});
export type InviteOwner = z.infer<typeof InviteOwner>;

export const InviteView = z.object({
  code: z.string(),
  created_at: z.number(),
  expires_at: z.number().nullable(),
  max_uses: z.number(),
  note: z.string().nullable(),
  /** The owners registered with this code, first registered first. */
  owners: z.array(InviteOwner),
  revoked_at: z.number().nullable(),
  uses: z.number(),
});
export type InviteView = z.infer<typeof InviteView>;

export function inviteView(row: InviteRow, owners: InviteOwner[] = []): InviteView {
  return {
    code: row.code,
    created_at: row.created_at.getTime(),
    expires_at: row.expires_at?.getTime() ?? null,
    max_uses: row.max_uses,
    note: row.note,
    owners,
    revoked_at: row.revoked_at?.getTime() ?? null,
    uses: row.uses,
  };
}

/**
 * The owners each of these codes admitted, in one query: an owner keeps the
 * normalized code it registered with (`owners.invite_code`, spent by
 * consumeInvite). A code nobody used is absent from the map.
 */
export async function ownersByCode(codes: string[]): Promise<Map<string, InviteOwner[]>> {
  const byCode = new Map<string, InviteOwner[]>();
  if (codes.length === 0) {
    return byCode;
  }
  const owners = await prisma.owner.findMany({
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    select: { created_at: true, email: true, id: true, invite_code: true },
    where: { invite_code: { in: codes } },
  });
  for (const owner of owners) {
    if (owner.invite_code) {
      const admitted = byCode.get(owner.invite_code) ?? [];
      admitted.push({
        created_at: owner.created_at.getTime(),
        email: owner.email,
        owner_id: owner.id,
      });
      byCode.set(owner.invite_code, admitted);
    }
  }
  return byCode;
}

/** Views of these codes, each with the owners it admitted. */
export async function inviteViews(rows: InviteRow[]): Promise<InviteView[]> {
  const owners = await ownersByCode(rows.map((row) => row.code));
  return rows.map((row) => inviteView(row, owners.get(row.code)));
}

/** One code's view, with the owners it admitted. */
export async function inviteViewWithOwners(row: InviteRow): Promise<InviteView> {
  const owners = await ownersByCode([row.code]);
  return inviteView(row, owners.get(row.code));
}

export type InviteProblem = "unknown" | "revoked" | "expired" | "used up";

/** Why a code cannot admit anyone now, or null when it can. */
export function inviteProblem(row: InviteRow | null, now = new Date()): InviteProblem | null {
  if (!row) {
    return "unknown";
  }
  if (row.revoked_at) {
    return "revoked";
  }
  if (row.expires_at && row.expires_at.getTime() <= now.getTime()) {
    return "expired";
  }
  if (row.uses >= row.max_uses) {
    return "used up";
  }
  return null;
}

function refused(problem: InviteProblem): ORPCError<"FORBIDDEN", undefined> {
  return new ORPCError("FORBIDDEN", { message: `This invite code is ${problem}` });
}

/** The normalized code when it can admit someone now; throws FORBIDDEN otherwise. */
export async function assertInviteUsable(code: string): Promise<string> {
  const normalized = normalizeInviteCode(code);
  const row = await prisma.invite.findUnique({ where: { code: normalized } });
  const problem = inviteProblem(row);
  if (problem) {
    throw refused(problem);
  }
  return normalized;
}

/**
 * Spend one use of a code, inside the transaction that creates the owner, so
 * two registrations racing for the last use cannot both get in. Throws
 * FORBIDDEN, rolling the transaction back, when the code can no longer admit.
 */
export async function consumeInvite(tx: Prisma.TransactionClient, code: string): Promise<void> {
  const spent = await tx.$executeRaw`
    UPDATE "invites" SET "uses" = "uses" + 1
    WHERE "code" = ${code} AND "revoked_at" IS NULL
      AND ("expires_at" IS NULL OR "expires_at" > NOW())
      AND "uses" < "max_uses"`;
  if (spent !== 1) {
    const row = await tx.invite.findUnique({ where: { code } });
    throw refused(inviteProblem(row) ?? "used up");
  }
}

export interface NewInvites {
  count: number;
  expires_in_days?: number;
  max_uses: number;
  note?: string;
}

export async function createInvites(spec: NewInvites): Promise<InviteRow[]> {
  const expiresAt = spec.expires_in_days
    ? new Date(Date.now() + spec.expires_in_days * 24 * 60 * 60 * 1000)
    : null;
  const rows: InviteRow[] = [];
  for (let i = 0; i < spec.count; i += 1) {
    rows.push(
      await prisma.invite.create({
        data: {
          code: generateInviteCode(),
          expires_at: expiresAt,
          max_uses: spec.max_uses,
          note: spec.note ?? null,
        },
      }),
    );
  }
  return rows;
}

export function listInvites(limit: number): Promise<InviteRow[]> {
  return prisma.invite.findMany({ orderBy: { created_at: "desc" }, take: limit });
}

/** A code by its normalized form; NOT_FOUND when there is none. */
async function existingInvite(code: string): Promise<InviteRow> {
  const row = await prisma.invite.findUnique({ where: { code: normalizeInviteCode(code) } });
  if (!row) {
    throw new ORPCError("NOT_FOUND", { message: "Invite code not found" });
  }
  return row;
}

/**
 * Change who a code is for. Surrounding space is dropped and a blank note
 * clears it; nothing else about the code changes, revoked or not.
 */
export async function updateInviteNote(code: string, note: string | null): Promise<InviteRow> {
  const row = await existingInvite(code);
  const trimmed = note?.trim() ?? "";
  return prisma.invite.update({
    data: { note: trimmed === "" ? null : trimmed },
    where: { code: row.code },
  });
}

/** Revoking is idempotent: a revoked code stays revoked, with its first revocation time. */
export async function revokeInvite(code: string): Promise<InviteRow> {
  const row = await existingInvite(code);
  if (row.revoked_at) {
    return row;
  }
  return prisma.invite.update({ data: { revoked_at: new Date() }, where: { code: row.code } });
}
