import { ORPCError } from "@orpc/server";
import * as z from "zod";
import {
  GrantView,
  OwnerAccessView,
  createGrant,
  listGrants,
  ownerAccessView,
  revokeGrant,
  setHandle,
} from "#/lib/access";
import { administrator } from "#/lib/auth";
import { prisma } from "#/lib/prisma";

// ---------------------------------------------------------------------------
// The access gate's administration (lib/access.ts): handles, and grants to
// resources other than the ledger. Administrator token only.
// ---------------------------------------------------------------------------

export const setOwnerHandle = administrator
  .route({
    description:
      "Give an owner its handle: the short public name every resource behind the access gate uses as this owner's namespace, as in `share.stair-ai.com/<handle>/`. " +
      "2 to 32 lowercase letters, digits or hyphens, starting with a letter. A handle another owner holds answers 409. Links made under a handle stop working when it changes, so changing or clearing (`null`) an existing handle needs `replace: true`. Administrator token only.",
    method: "PUT",
    path: "/admin/owners/{owner_id}/handle",
    summary: "Set owner handle",
    tags: ["Administration"],
  })
  .input(
    z.object({
      handle: z.string().max(64).nullable(),
      owner_id: z.string().uuid(),
      replace: z.boolean().default(false),
    }),
  )
  .output(OwnerAccessView)
  .handler(({ input }) => setHandle(input.owner_id, input.handle, input.replace));

export const lookupOwner = administrator
  .route({
    description:
      "Find one owner by `owner_id`, `email` or `handle` (exactly one), with its handle and live grants. Administrator token only.",
    method: "GET",
    path: "/admin/owners/lookup",
    summary: "Look up owner",
    tags: ["Administration"],
  })
  .input(
    z.object({
      email: z.string().max(320).optional(),
      handle: z.string().max(64).optional(),
      owner_id: z.string().uuid().optional(),
    }),
  )
  .output(OwnerAccessView)
  .handler(async ({ input }) => {
    const given = [input.owner_id, input.email, input.handle].filter((v) => v !== undefined);
    if (given.length !== 1) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Give exactly one of owner_id, email, handle",
      });
    }
    const owner = await prisma.owner.findFirst({
      select: { id: true },
      where: input.owner_id
        ? { id: input.owner_id }
        : input.email
          ? { email: input.email }
          : { handle: input.handle },
    });
    if (!owner) {
      throw new ORPCError("NOT_FOUND", { message: "Owner not found" });
    }
    return ownerAccessView(owner.id);
  });

export const createAccessGrant = administrator
  .route({
    description:
      "Let an owner get access tokens for a resource (`POST /access/token`): `resource` is its canonical URL, the audience of the tokens, and `scopes` what the owner may ask for there, such as `share:write`. " +
      "Replaces the owner's live grant for that resource, if any. Administrator token only.",
    method: "POST",
    path: "/admin/grants",
    summary: "Grant access to a resource",
    tags: ["Administration"],
  })
  .input(
    z.object({
      note: z.string().max(200).optional(),
      owner_id: z.string().uuid(),
      resource: z.string().max(512),
      scopes: z.array(z.string().max(64)).min(1).max(20),
    }),
  )
  .output(GrantView)
  .handler(({ input }) => createGrant(input));

export const listAccessGrants = administrator
  .route({
    description:
      "List grants, newest first: live ones by default, every one with `state=all`; narrowed by `owner_id` or `resource`. Administrator token only.",
    method: "GET",
    path: "/admin/grants",
    summary: "List grants",
    tags: ["Administration"],
  })
  .input(
    z
      .object({
        owner_id: z.string().uuid().optional(),
        resource: z.string().max(512).optional(),
        state: z.enum(["live", "all"]).default("live"),
      })
      .optional(),
  )
  .output(z.object({ grants: z.array(GrantView) }))
  .handler(async ({ input }) => ({
    grants: await listGrants({
      owner_id: input?.owner_id,
      resource: input?.resource,
      state: input?.state ?? "live",
    }),
  }));

export const revokeAccessGrant = administrator
  .route({
    description:
      "Revoke a grant: the gate issues no more tokens under it. Tokens already issued stay valid until they expire, at most the gate's token lifetime (an hour by default). Administrator token only.",
    method: "POST",
    path: "/admin/grants/{grant_id}/revoke",
    summary: "Revoke grant",
    tags: ["Administration"],
  })
  .input(z.object({ grant_id: z.string().uuid() }))
  .output(GrantView)
  .handler(({ input }) => revokeGrant(input.grant_id));

export const accessRouter = {
  createAccessGrant,
  listAccessGrants,
  lookupOwner,
  revokeAccessGrant,
  setOwnerHandle,
};
