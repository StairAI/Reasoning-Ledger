import * as z from "zod";

// ---------------------------------------------------------------------------
// Owner request schemas
// ---------------------------------------------------------------------------

export const RegisterOwnerInput = z.object({
  contact_email: z.string().email().optional(),
  display_name: z.string().optional(),
  email: z.string().email(),
  /** Required when wallet_mode is "byow"; ignored in custodial mode. */
  owner_wallet_address: z.string().optional(),
  wallet_mode: z.enum(["custodial", "byow"]).default("custodial"),
  website: z.string().url().optional(),
});
export type RegisterOwnerInput = z.infer<typeof RegisterOwnerInput>;

export const UpdateOwnerInput = z.object({
  contact_email: z.string().email().optional(),
  display_name: z.string().optional(),
  website: z.string().url().optional(),
});
export type UpdateOwnerInput = z.infer<typeof UpdateOwnerInput>;

// ---------------------------------------------------------------------------
// Owner response schemas
// ---------------------------------------------------------------------------

/** Returned once at registration — raw api_key is never stored. */
export const RegisterOwnerOutput = z.object({
  api_key: z.string().optional(), // present only on first creation
  contact_email: z.string().optional(),
  created_at: z.number(),
  display_name: z.string().optional(),
  owner_id: z.string().uuid(),
  owner_wallet_address: z.string(),
  wallet_mode: z.enum(["custodial", "byow"]),
  website: z.string().optional(), // epoch ms
});
export type RegisterOwnerOutput = z.infer<typeof RegisterOwnerOutput>;

export const OwnerMetaOutput = z.object({
  contact_email: z.string().optional(),
  created_at: z.number(),
  display_name: z.string().optional(),
  owner_id: z.string().uuid(),
  owner_wallet_address: z.string(),
  updated_at: z.number(),
  wallet_mode: z.enum(["custodial", "byow"]),
  website: z.string().optional(),
});
export type OwnerMetaOutput = z.infer<typeof OwnerMetaOutput>;

export const RotateKeyOutput = z.object({
  api_key: z.string(), // new raw key, shown once
});
export type RotateKeyOutput = z.infer<typeof RotateKeyOutput>;
