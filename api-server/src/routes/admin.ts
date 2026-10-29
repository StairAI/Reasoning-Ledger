import * as z from "zod";
import { administrator } from "#/lib/auth";
import {
  InviteCode,
  InviteView,
  createInvites,
  inviteView,
  listInvites,
  revokeInvite,
} from "#/lib/invites";

// ---------------------------------------------------------------------------
// Invite codes (lib/invites.ts). Administrator token only.
// ---------------------------------------------------------------------------

export const createInviteCodes = administrator
  .route({
    description:
      "Make invite codes for self-service registration (`RL_REGISTRATION=invite`). Each code admits `max_uses` registrations (default one) until it expires or is revoked; `note` says who it is for. " +
      "A person passes a code when registering (`POST /v1/owners` with `invite_code`), and it stays recorded on their owner. Administrator token only.",
    method: "POST",
    path: "/admin/invites",
    summary: "Create invite codes",
    tags: ["Administration"],
  })
  .input(
    z
      .object({
        count: z.number().int().min(1).max(100).default(1),
        expires_in_days: z.number().int().min(1).max(3650).optional(),
        max_uses: z.number().int().min(1).max(100_000).default(1),
        note: z.string().max(200).optional(),
      })
      .optional(),
  )
  .output(z.object({ invites: z.array(InviteView) }))
  .handler(async ({ input }) => {
    const rows = await createInvites({
      count: input?.count ?? 1,
      expires_in_days: input?.expires_in_days,
      max_uses: input?.max_uses ?? 1,
      note: input?.note,
    });
    return { invites: rows.map(inviteView) };
  });

export const listInviteCodes = administrator
  .route({
    description:
      "List invite codes, newest first, with how many times each was used. Administrator token only.",
    method: "GET",
    path: "/admin/invites",
    summary: "List invite codes",
    tags: ["Administration"],
  })
  .input(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(500) }).optional())
  .output(z.object({ invites: z.array(InviteView) }))
  .handler(async ({ input }) => {
    const rows = await listInvites(input?.limit ?? 500);
    return { invites: rows.map(inviteView) };
  });

export const revokeInviteCode = administrator
  .route({
    description:
      "Revoke an invite code: it admits nobody from now on; owners it already admitted keep their accounts. Administrator token only.",
    method: "POST",
    path: "/admin/invites/{code}/revoke",
    summary: "Revoke invite code",
    tags: ["Administration"],
  })
  .input(z.object({ code: InviteCode }))
  .output(InviteView)
  .handler(async ({ input }) => inviteView(await revokeInvite(input.code)));

export const adminRouter = {
  createInviteCodes,
  listInviteCodes,
  revokeInviteCode,
};
