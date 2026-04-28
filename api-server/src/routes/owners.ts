import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { generateApiKey, hashApiKey } from "#/lib/crypto";
import { generateWalletAddress } from "#/lib/wallet";
import { authed, base } from "#/lib/auth";
import { RegisterOwnerInput, UpdateOwnerInput } from "#/schemas/owners";

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
    contact_email: owner.contact_email ?? undefined,
    created_at: owner.created_at.getTime(),
    display_name: owner.display_name ?? undefined,
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
      "Register a new owner, or resolve the existing one when the e-mail is already on file (idempotent). " +
      "The raw `api_key` is returned **only on the first call** — it is never stored and cannot be retrieved again. " +
      "Wallet mode (`custodial` | `byow`) is locked at registration and applies to every agent created under this owner.",
    method: "POST",
    path: "/v1/owners",
    // Public endpoint — no API key required.
    spec: { security: [] },
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
      owner_id: z.string(),
      owner_wallet_address: z.string(),
      wallet_mode: z.enum(["custodial", "byow"]),
      website: z.string().optional(),
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
        api_key_hash: hashApiKey(rawKey),
        contact_email: input.contact_email,
        display_name: input.display_name,
        email: input.email,
        owner_wallet_address: walletAddress,
        wallet_mode: input.wallet_mode,
        website: input.website,
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
  .route({
    description:
      "Update display metadata (`display_name`, `website`, `contact_email`) for the owner identified by the `X-API-Key` header. " +
      "Only fields present in the request body are updated; omitted fields are left unchanged.",
    method: "PATCH",
    path: "/v1/owners/me",
    summary: "Update owner metadata",
    tags: ["Owners"],
  })
  .input(UpdateOwnerInput)
  .output(
    z.object({
      contact_email: z.string().optional(),
      created_at: z.number(),
      display_name: z.string().optional(),
      owner_id: z.string(),
      owner_wallet_address: z.string(),
      updated_at: z.number(),
      wallet_mode: z.enum(["custodial", "byow"]),
      website: z.string().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const owner = await prisma.owner.update({
      data: {
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
    path: "/v1/owners/me/rotate-key",
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
  registerOwner,
  rotateKey,
  updateOwner,
};
