import * as z from "zod";
import { ADMIN_READS, logAdminRead } from "#/lib/admin";
import { authed, reader } from "#/lib/auth";
import {
  ContentKeyBody,
  ContentKeyView,
  KeyId,
  contentKeyView,
  ownedContentKey,
  ownedContentKeys,
  registerContentKey,
} from "#/lib/content-keys";
import { ORPCError } from "@orpc/server";

// ---------------------------------------------------------------------------
// PUT /v1/content-keys/{key_id}
// Register the wrapped data key that encrypted content names in
// ContentRef.enc.key_id (lib/content-keys.ts).
// ---------------------------------------------------------------------------

export const putContentKey = authed
  .route({
    description:
      "Register a wrapped data key. Content is encrypted on your machine with a data key, one per session; wrap that key with your master key and register the wrapped copy here under a `key_id` of your choice, before submitting records whose content references name it (`enc.key_id`). " +
      "The server keeps only the wrapped key and cannot open it. Calling again with the same `key_id` replaces the wrapped copy: that is how a master key is rotated (re-wrap every key, then switch). " +
      "`wrapped_key` is base64 of nonce (12 bytes) + the wrapped 32-byte key + tag (16 bytes), AES-256-GCM under the master key with the key id as associated data; `master_key_id` is the first 16 hex characters of SHA-256(master key), so a reader can tell which master key opens it.",
    method: "PUT",
    path: "/content-keys/{key_id}",
    summary: "Register content key",
    tags: ["Content keys"],
  })
  .input(ContentKeyBody.extend({ key_id: KeyId }))
  .output(ContentKeyView.extend({ created: z.boolean() }))
  .handler(async ({ input, context }) => {
    const { key_id: keyId, ...body } = input;
    const { key, created } = await registerContentKey(context.ownerId, keyId, body);
    return { ...key, created };
  });

// ---------------------------------------------------------------------------
// GET /v1/content-keys/{key_id}
// ---------------------------------------------------------------------------

export const getContentKey = reader
  .route({
    description: `Fetch one of your wrapped data keys by \`key_id\`. Another owner's key answers 404, the same as one that does not exist.${ADMIN_READS}`,
    method: "GET",
    path: "/content-keys/{key_id}",
    summary: "Get content key",
    tags: ["Content keys"],
  })
  .input(z.object({ key_id: KeyId }))
  .output(ContentKeyView)
  .handler(async ({ input, context }) => {
    const row = await ownedContentKey(context.ownerId, input.key_id);
    if (!row) {
      throw new ORPCError("NOT_FOUND", { message: "Content key not found" });
    }
    if (context.admin) {
      logAdminRead("content_key", { key_id: input.key_id, owner_id: row.owner_id });
    }
    return contentKeyView(row);
  });

// ---------------------------------------------------------------------------
// GET /v1/content-keys
// ---------------------------------------------------------------------------

export const listContentKeys = reader
  .route({
    description: `List your wrapped data keys in \`key_id\` order, optionally those of one session or agent; \`after\` continues from the \`next_after\` of the previous page. A writer rotating its master key reads every key this way, re-wraps each and registers it again.${ADMIN_READS}`,
    method: "GET",
    path: "/content-keys",
    summary: "List content keys",
    tags: ["Content keys"],
  })
  .input(
    z
      .object({
        after: KeyId.optional(),
        agent_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
        /** Administrator only: one owner's keys. */
        owner_id: z.string().uuid().optional(),
        session_id: z.string().min(1).max(256).optional(),
      })
      .optional(),
  )
  .output(z.object({ keys: z.array(ContentKeyView), next_after: z.string().nullable() }))
  .handler(async ({ input, context }) => {
    const filter = input ?? { limit: 200 };
    const page = await ownedContentKeys(context.ownerId, {
      after: filter.after,
      agent_id: filter.agent_id,
      limit: filter.limit,
      owner_id: context.admin ? filter.owner_id : undefined,
      session_id: filter.session_id,
    });
    if (context.admin) {
      logAdminRead("content_keys", { count: page.keys.length, owner_id: filter.owner_id ?? null });
    }
    return { keys: page.keys.map(contentKeyView), next_after: page.next_after };
  });

export const contentKeysRouter = {
  getContentKey,
  listContentKeys,
  putContentKey,
};
