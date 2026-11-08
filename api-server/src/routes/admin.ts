import * as z from "zod";
import { inviteManager } from "#/lib/auth";
import {
  InviteCode,
  InviteView,
  createInvites,
  inviteView,
  inviteViewWithOwners,
  inviteViews,
  listInvites,
  revokeInvite,
  updateInviteNote,
} from "#/lib/invites";

// ---------------------------------------------------------------------------
// Invite codes (lib/invites.ts). The administrator token, or the registration
// token, held by the application that signs people up and hands codes out.
// ---------------------------------------------------------------------------

const WHO_MAY =
  " Administrator token or registration token (`RL_REGISTRATION_TOKEN`), in `X-Admin-Token`.";

export const createInviteCodes = inviteManager
  .route({
    description:
      `Make invite codes for self-service registration (\`RL_REGISTRATION=invite\`). Each code admits \`max_uses\` registrations (default one) until it expires or is revoked; \`note\` says who it is for. ` +
      `A person passes a code when registering (\`POST /v1/owners\` with \`invite_code\`), and it stays recorded on their owner.${
        WHO_MAY
      }`,
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
    // New codes have admitted nobody yet.
    return { invites: rows.map((row) => inviteView(row)) };
  });

export const listInviteCodes = inviteManager
  .route({
    description: `List invite codes, newest first, with how many times each was used and the owners each admitted (\`owners\`: \`owner_id\`, \`email\` when the owner has one, and \`created_at\`, when it registered; first registered first).${
      WHO_MAY
    }`,
    method: "GET",
    path: "/admin/invites",
    summary: "List invite codes",
    tags: ["Administration"],
  })
  .input(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(500) }).optional())
  .output(z.object({ invites: z.array(InviteView) }))
  .handler(async ({ input }) => {
    const rows = await listInvites(input?.limit ?? 500);
    return { invites: await inviteViews(rows) };
  });

export const updateInviteCode = inviteManager
  .route({
    description: `Change an invite code's \`note\`, which says who it is for; \`null\` or a blank note clears it. Nothing else about the code changes, revoked or not. The code is matched without case or surrounding space; an unknown one answers 404.${
      WHO_MAY
    }`,
    method: "PATCH",
    path: "/admin/invites/{code}",
    summary: "Update invite code",
    tags: ["Administration"],
  })
  .input(z.object({ code: InviteCode, note: z.string().max(200).nullable() }))
  .output(InviteView)
  .handler(async ({ input }) =>
    inviteViewWithOwners(await updateInviteNote(input.code, input.note)),
  );

export const revokeInviteCode = inviteManager
  .route({
    description: `Revoke an invite code: it admits nobody from now on; owners it already admitted keep their accounts.${
      WHO_MAY
    }`,
    method: "POST",
    path: "/admin/invites/{code}/revoke",
    summary: "Revoke invite code",
    tags: ["Administration"],
  })
  .input(z.object({ code: InviteCode }))
  .output(InviteView)
  .handler(async ({ input }) => inviteViewWithOwners(await revokeInvite(input.code)));

export const adminRouter = {
  createInviteCodes,
  listInviteCodes,
  revokeInviteCode,
  updateInviteCode,
};
