import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { generateApiKey, hashApiKey } from "#/lib/crypto";
import { generateWalletAddress } from "#/lib/wallet";
import { authed, base } from "#/lib/auth";
import { consumeInvite } from "#/lib/invites";
import { admitRegistration } from "#/lib/registration";
import { RegisterOwnerInput, UpdateOwnerInput } from "#/schemas/owners";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ownerToMeta(owner: {
  id: string;
  wallet_mode: string;
  owner_wallet_address: string | null;
  display_name: string | null;
  website: string | null;
  contact_email: string | null;
  email: string | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    contact_email: owner.contact_email ?? undefined,
    created_at: owner.created_at.getTime(),
    display_name: owner.display_name ?? undefined,
    email: owner.email ?? undefined,
    owner_id: owner.id,
    owner_wallet_address: owner.owner_wallet_address,
    updated_at: owner.updated_at.getTime(),
    wallet_mode: owner.wallet_mode as "custodial" | "byow",
    website: owner.website ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/owners
// Register a new owner (or return the existing one for idempotency on email).
// Returns the raw api_key ONLY on first creation — never again.
// ---------------------------------------------------------------------------

export const registerOwner = base
  .route({
    description:
      "Register a new owner. With an `email`, idempotent: the existing owner with that e-mail is resolved instead. Without one, the registration is anonymous: the keys are the identity, a new owner is made each time, and an e-mail can be claimed later with `PATCH /v1/owners/me`. " +
      "Private deployments allow this only with the administrator token (`X-Admin-Token`); a hosted instance may open it to self-service with a per-address rate limit, or by invitation, when `invite_code` is required (`RL_REGISTRATION=invite`). A code is checked whenever it is given, spent when the owner is created, and recorded on the owner. " +
      "The raw `api_key` is returned **only on the first call** — it is never stored and cannot be retrieved again. " +
      "Wallet mode (`custodial` | `byow`) is locked at registration and applies to every agent created under this owner.",
    method: "POST",
    path: "/owners",
    // No owner API key: access is decided by assertRegistrationAllowed. Use the
    // function form of `spec` so the generated operation (summary, tags,
    // requestBody, …) is preserved; a plain object would REPLACE it.
    spec: (current) => ({ ...current, security: [] }),
    summary: "Register owner",
    tags: ["Owners"],
  })
  .input(RegisterOwnerInput)
  .output(
    z.object({
      api_key: z.string().optional(),
      contact_email: z.string().optional(),
      created_at: z.number(),
      display_name: z.string().optional(),
      email: z.string().optional(),
      owner_id: z.string(),
      owner_wallet_address: z.string().nullable(),
      wallet_mode: z.enum(["custodial", "byow"]),
      website: z.string().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const admission = await admitRegistration(context.headers, input.invite_code);

    // Idempotency: an owner with this e-mail already exists, so return metadata.
    // An anonymous registration has nothing to be idempotent on: it is always a new owner.
    const existing = input.email
      ? await prisma.owner.findUnique({ where: { email: input.email } })
      : null;

    if (existing) {
      // Do NOT re-expose the api_key — return metadata only.
      return ownerToMeta(existing);
    }

    // Validate BYOW: must supply an address.
    if (input.wallet_mode === "byow" && !input.owner_wallet_address) {
      throw new ORPCError("BAD_REQUEST", {
        message: "owner_wallet_address is required when wallet_mode is 'byow'",
      });
    }

    const rawKey = generateApiKey();
    const walletAddress =
      input.wallet_mode === "byow" && input.owner_wallet_address
        ? input.owner_wallet_address
        : generateWalletAddress();

    // The invite's use is spent in the same transaction as the owner, so a
    // code with one use left admits exactly one of two racing registrations.
    const owner = await prisma.$transaction(async (tx) => {
      if (admission.invite) {
        await consumeInvite(tx, admission.invite);
      }
      return tx.owner.create({
        data: {
          api_key_hash: hashApiKey(rawKey),
          contact_email: input.contact_email,
          display_name: input.display_name,
          email: input.email ?? null,
          invite_code: admission.invite,
          owner_wallet_address: walletAddress,
          wallet_mode: input.wallet_mode,
          website: input.website,
        },
      });
    });

    return {
      ...ownerToMeta(owner),
      api_key: rawKey, // shown once
    };
  });

// ---------------------------------------------------------------------------
// GET /v1/owners/me
// Resolve the calling owner's identity and metadata from their API key.
// ---------------------------------------------------------------------------

export const getOwner = authed
  .route({
    description:
      "Resolve the owner identified by the `X-API-Key` header. " +
      "Returns owner metadata including `owner_id` and `wallet_mode`.",
    method: "GET",
    path: "/owners/me",
    summary: "Get owner",
    tags: ["Owners"],
  })
  .input(z.object({}))
  .output(
    z.object({
      contact_email: z.string().optional(),
      created_at: z.number(),
      display_name: z.string().optional(),
      email: z.string().optional(),
      owner_id: z.string(),
      owner_wallet_address: z.string().nullable(),
      updated_at: z.number(),
      wallet_mode: z.enum(["custodial", "byow"]),
      website: z.string().optional(),
    }),
  )
  .handler(async ({ context }) => {
    const owner = await prisma.owner.findUniqueOrThrow({
      where: { id: context.ownerId },
    });

    return ownerToMeta(owner);
  });

// ---------------------------------------------------------------------------
// PATCH /v1/owners/me
// Update the calling owner's display metadata.
// ---------------------------------------------------------------------------

export const updateOwner = authed
  .route({
    description:
      "Update display metadata (`display_name`, `website`, `contact_email`) for the owner identified by the `X-API-Key` header, or claim an `email` for an anonymous owner (one that no other owner holds; 409 otherwise). " +
      "Only fields present in the request body are updated; omitted fields are left unchanged.",
    method: "PATCH",
    path: "/owners/me",
    summary: "Update owner metadata",
    tags: ["Owners"],
  })
  .input(UpdateOwnerInput)
  .output(
    z.object({
      contact_email: z.string().optional(),
      created_at: z.number(),
      display_name: z.string().optional(),
      email: z.string().optional(),
      owner_id: z.string(),
      owner_wallet_address: z.string().nullable(),
      updated_at: z.number(),
      wallet_mode: z.enum(["custodial", "byow"]),
      website: z.string().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    if (input.email !== undefined) {
      const holder = await prisma.owner.findUnique({
        select: { id: true },
        where: { email: input.email },
      });
      if (holder && holder.id !== context.ownerId) {
        throw new ORPCError("CONFLICT", { message: "That e-mail belongs to another owner" });
      }
    }
    const owner = await prisma.owner.update({
      data: {
        ...(input.email !== undefined && { email: input.email }),
        ...(input.display_name !== undefined && { display_name: input.display_name }),
        ...(input.website !== undefined && { website: input.website }),
        ...(input.contact_email !== undefined && { contact_email: input.contact_email }),
      },
      where: { id: context.ownerId },
    });

    return ownerToMeta(owner);
  });

// ---------------------------------------------------------------------------
// POST /v1/owners/me/rotate-key
// Issue a new api_key and immediately invalidate the previous one.
// Returns the new raw key (shown once).
// ---------------------------------------------------------------------------

export const rotateKey = authed
  .route({
    description:
      "Issue a new `api_key` and immediately invalidate the previous one. " +
      "The new raw key is returned once and never stored — store it securely before discarding the response.",
    method: "POST",
    path: "/owners/me/rotate-key",
    summary: "Rotate API key",
    tags: ["Owners"],
  })
  .input(z.object({}))
  .output(z.object({ api_key: z.string() }))
  .handler(async ({ context }) => {
    const rawKey = generateApiKey();

    await prisma.owner.update({
      data: { api_key_hash: hashApiKey(rawKey) },
      where: { id: context.ownerId },
    });

    return { api_key: rawKey };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const ownersRouter = {
  getOwner,
  registerOwner,
  rotateKey,
  updateOwner,
};
