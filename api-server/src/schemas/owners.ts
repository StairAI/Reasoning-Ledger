import * as z from "zod";

// ---------------------------------------------------------------------------
// Owner request schemas
// ---------------------------------------------------------------------------

export const RegisterOwnerInput = z.object({
  email: z.string().email(),
  wallet_mode: z.enum(["custodial", "byow"]).default("custodial"),
  /** Required when wallet_mode is "byow"; ignored in custodial mode. */
  owner_wallet_address: z.string().optional(),
  display_name: z.string().optional(),
  website: z.string().url().optional(),
  contact_email: z.string().email().optional(),
});
export type RegisterOwnerInput = z.infer<typeof RegisterOwnerInput>;

export const UpdateOwnerInput = z.object({
  display_name: z.string().optional(),
  website: z.string().url().optional(),
  contact_email: z.string().email().optional(),
});
export type UpdateOwnerInput = z.infer<typeof UpdateOwnerInput>;

// ---------------------------------------------------------------------------
// Owner response schemas
// ---------------------------------------------------------------------------

/** Returned once at registration — raw api_key is never stored. */
export const RegisterOwnerOutput = z.object({
  owner_id: z.string().uuid(),
  api_key: z.string().optional(), // present only on first creation
  wallet_mode: z.enum(["custodial", "byow"]),
  owner_wallet_address: z.string(),
  display_name: z.string().optional(),
  website: z.string().optional(),
  contact_email: z.string().optional(),
  created_at: z.number(), // epoch ms
});
export type RegisterOwnerOutput = z.infer<typeof RegisterOwnerOutput>;

export const OwnerMetaOutput = z.object({
  owner_id: z.string().uuid(),
  wallet_mode: z.enum(["custodial", "byow"]),
  owner_wallet_address: z.string(),
  display_name: z.string().optional(),
  website: z.string().optional(),
  contact_email: z.string().optional(),
  created_at: z.number(),
  updated_at: z.number(),
});
export type OwnerMetaOutput = z.infer<typeof OwnerMetaOutput>;

export const RotateKeyOutput = z.object({
  api_key: z.string(), // new raw key, shown once
});
export type RotateKeyOutput = z.infer<typeof RotateKeyOutput>;
