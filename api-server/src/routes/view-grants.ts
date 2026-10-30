import * as z from "zod";
import { ORPCError } from "@orpc/server";
import { authed } from "#/lib/auth";
import { KeyId } from "#/lib/content-keys";
import {
  GRANT_MAX_KEYS,
  GRANT_MAX_SECONDS,
  GRANT_PATH,
  createViewGrant as create,
  listViewGrants as list,
  revokeViewGrant as revoke,
} from "#/lib/view-grants";

// ---------------------------------------------------------------------------
// View grants (lib/view-grants.ts): a time-limited authorization to read some
// of your sessions in the trace viewer. Only an owner's API key manages them.
// ---------------------------------------------------------------------------

const GrantKey = z.object({
  key_id: KeyId,
  /** The first 16 hex characters of SHA-256(grant key). */
  master_key_id: z.string().regex(/^[0-9a-f]{16}$/),
  wrap_alg: z.literal("A256GCM"),
  /** base64 of nonce (12 bytes) + the wrapped 32-byte data key + tag (16 bytes). */
  wrapped_key: z.string().min(1).max(256),
});

const GrantSummary = z.object({
  created_at: z.number(),
  ended_at: z.number().nullable(),
  expires_at: z.number(),
  grant_id: z.string(),
  purpose: z.string(),
  revoked_at: z.number().nullable(),
  sessions: z.number(),
});

export const createViewGrant = authed
  .route({
    description:
      "Grant a view of some of your sessions, for a limited time, without your master key leaving your machine. " +
      "Pick the sessions, unwrap their data keys (see Content keys) with your master key, wrap each again with a fresh 32-byte grant key the same way (AES-256-GCM, the key id as associated data, `master_key_id` = the first 16 hex characters of SHA-256(grant key)), and send them here. " +
      "Every key must be one of yours, and none may be wrapped under the master key that wrapped your own copy. The grant opens the sessions of those keys. " +
      "Send the browser to `grant_url` (relative to this server's origin) followed by `#k=` and the grant key in base64url: the fragment never reaches the server, and the viewer decrypts with it in the browser. " +
      "The link works, and can be reopened, until `expires_at` (epoch milliseconds; `expires_in` seconds from now, one hour unless given, at most a day) or until you revoke the grant; then its keys are dropped, and a grant key left in a browser's history opens nothing.",
    method: "POST",
    path: "/view-grants",
    summary: "Grant a view",
    tags: ["Viewer"],
  })
  .input(
    z.object({
      expires_in: z.number().int().min(60).max(GRANT_MAX_SECONDS).optional(),
      keys: z.array(GrantKey).min(1).max(GRANT_MAX_KEYS),
      purpose: z.literal("view").optional(),
    }),
  )
  .output(
    z.object({
      expires_at: z.number(),
      grant_id: z.string(),
      grant_url: z.string(),
      sessions: z.number(),
    }),
  )
  .handler(async ({ input, context }) => {
    const grant = await create(context.ownerId, input);
    return {
      expires_at: grant.expiresAt.getTime(),
      grant_id: grant.id,
      grant_url: `${GRANT_PATH}${grant.token}`,
      sessions: grant.sessions,
    };
  });

export const listViewGrants = authed
  .route({
    description:
      "Your view grants, newest first (at most 100), without their keys or links: what was granted, for how long, and whether it ended.",
    method: "GET",
    path: "/view-grants",
    summary: "List view grants",
    tags: ["Viewer"],
  })
  .output(z.object({ grants: z.array(GrantSummary) }))
  .handler(async ({ context }) => ({ grants: await list(context.ownerId) }));

export const revokeViewGrant = authed
  .route({
    description:
      "End a view grant now: its keys are dropped and every browser it opened is signed out. 404 when you have no such grant in force.",
    method: "DELETE",
    path: "/view-grants/{grant_id}",
    summary: "Revoke view grant",
    tags: ["Viewer"],
  })
  .input(z.object({ grant_id: z.string().min(1).max(64) }))
  .output(z.object({ revoked: z.boolean() }))
  .handler(async ({ input, context }) => {
    if (!(await revoke(context.ownerId, input.grant_id))) {
      throw new ORPCError("NOT_FOUND", { message: "View grant not found, or already revoked" });
    }
    return { revoked: true };
  });

export const viewGrantsRouter = {
  createViewGrant,
  listViewGrants,
  revokeViewGrant,
};
