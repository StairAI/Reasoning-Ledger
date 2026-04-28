import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { generateApiKey, hashApiKey } from "#/lib/crypto";
import { generateWalletAddress } from "#/lib/wallet";
import { authed, base } from "#/lib/auth";
import {
  RegisterOwnerInput,
  UpdateOwnerInput,
} from "#/schemas/owners";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ownerToMeta(owner: {
  id: string;
  wallet_mode: string;
  owner_wallet_address: string;
  display_name: string | null;
  website: string | null;
  contact_email: string | null;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    owner_id: owner.id,
    wallet_mode: owner.wallet_mode as "custodial" | "byow",
    owner_wallet_address: owner.owner_wallet_address,
    display_name: owner.display_name ?? undefined,
    website: owner.website ?? undefined,
    contact_email: owner.contact_email ?? undefined,
    created_at: owner.created_at.getTime(),
    updated_at: owner.updated_at.getTime(),
  };
}

// ---------------------------------------------------------------------------
// POST /v1/owners
// Register a new owner (or return the existing one for idempotency on email).
// Returns the raw api_key ONLY on first creation — never again.
// ---------------------------------------------------------------------------

export const registerOwner = base
  .route({ path: "/v1/owners", method: "POST" })
  .input(RegisterOwnerInput)
  .output(
    z.object({
      owner_id: z.string(),
      api_key: z.string().optional(),
      wallet_mode: z.enum(["custodial", "byow"]),
      owner_wallet_address: z.string(),
      display_name: z.string().optional(),
      website: z.string().optional(),
      contact_email: z.string().optional(),
      created_at: z.number(),
    }),
  )
  .handler(async ({ input }) => {
    // Idempotency: if owner with this email already exists, return metadata.
    const existing = await prisma.owner.findUnique({
      where: { email: input.email },
    });

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

    const owner = await prisma.owner.create({
      data: {
        email: input.email,
        api_key_hash: hashApiKey(rawKey),
        wallet_mode: input.wallet_mode,
        owner_wallet_address: walletAddress,
        display_name: input.display_name,
        website: input.website,
        contact_email: input.contact_email,
      },
    });

    return {
      ...ownerToMeta(owner),
      api_key: rawKey, // shown once
    };
  });

// ---------------------------------------------------------------------------
// PATCH /v1/owners/me
// Update the calling owner's display metadata.
// ---------------------------------------------------------------------------

export const updateOwner = authed
  .route({ path: "/v1/owners/me", method: "PATCH" })
  .input(UpdateOwnerInput)
  .output(
    z.object({
      owner_id: z.string(),
      wallet_mode: z.enum(["custodial", "byow"]),
      owner_wallet_address: z.string(),
      display_name: z.string().optional(),
      website: z.string().optional(),
      contact_email: z.string().optional(),
      created_at: z.number(),
      updated_at: z.number(),
    }),
  )
  .handler(async ({ input, context }) => {
    const owner = await prisma.owner.update({
      where: { id: context.ownerId },
      data: {
        ...(input.display_name !== undefined && { display_name: input.display_name }),
        ...(input.website !== undefined && { website: input.website }),
        ...(input.contact_email !== undefined && { contact_email: input.contact_email }),
      },
    });

    return ownerToMeta(owner);
  });

// ---------------------------------------------------------------------------
// POST /v1/owners/me/rotate-key
// Issue a new api_key and immediately invalidate the previous one.
// Returns the new raw key (shown once).
// ---------------------------------------------------------------------------

export const rotateKey = authed
  .route({ path: "/v1/owners/me/rotate-key", method: "POST" })
  .input(z.object({}))
  .output(z.object({ api_key: z.string() }))
  .handler(async ({ context }) => {
    const rawKey = generateApiKey();

    await prisma.owner.update({
      where: { id: context.ownerId },
      data: { api_key_hash: hashApiKey(rawKey) },
    });

    return { api_key: rawKey };
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const ownersRouter = {
  registerOwner,
  updateOwner,
  rotateKey,
};
