/**
 * Invite codes (registration policy `invite`, lib/registration.ts).
 *
 * An operator makes codes with the administrator token; a person registering
 * through the plugin passes one, and it stays recorded on the owner it
 * admitted. A code has a number of uses, may expire, and can be revoked. The
 * policy is a switch: set RL_REGISTRATION=open and codes are no longer asked
 * for, while the table and the attribution stay.
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

export const InviteView = z.object({
  code: z.string(),
  created_at: z.number(),
  expires_at: z.number().nullable(),
  max_uses: z.number(),
  note: z.string().nullable(),
  revoked_at: z.number().nullable(),
  uses: z.number(),
});
export type InviteView = z.infer<typeof InviteView>;

export function inviteView(row: InviteRow): InviteView {
  return {
    code: row.code,
    created_at: row.created_at.getTime(),
    expires_at: row.expires_at?.getTime() ?? null,
    max_uses: row.max_uses,
    note: row.note,
    revoked_at: row.revoked_at?.getTime() ?? null,
    uses: row.uses,
  };
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

/** Revoking is idempotent: a revoked code stays revoked, with its first revocation time. */
export async function revokeInvite(code: string): Promise<InviteRow> {
  const normalized = normalizeInviteCode(code);
  const row = await prisma.invite.findUnique({ where: { code: normalized } });
  if (!row) {
    throw new ORPCError("NOT_FOUND", { message: "Invite code not found" });
  }
  if (row.revoked_at) {
    return row;
  }
  return prisma.invite.update({ data: { revoked_at: new Date() }, where: { code: normalized } });
}
