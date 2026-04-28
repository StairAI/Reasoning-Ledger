import * as z from "zod";

// ---------------------------------------------------------------------------
// Agent request schemas
// ---------------------------------------------------------------------------

export const RegisterAgentInput = z.object({
  name: z.string().min(1).max(128),
  /** BYOW only — optional per-agent SUI address. Ignored in custodial mode. */
  wallet: z
    .object({
      address: z.string().min(1),
    })
    .optional(),
  description: z.string().optional(),
  website: z.string().url().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;

export const UpdateAgentInput = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().optional(),
  website: z.string().url().optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;

// ---------------------------------------------------------------------------
// Agent response schemas
// ---------------------------------------------------------------------------

export const AgentRegistrationOutput = z.object({
  agent_id: z.string().uuid(),
  name: z.string(),
  agent_wallet_address: z.string(),
  created_at: z.number(), // epoch ms
});
export type AgentRegistrationOutput = z.infer<typeof AgentRegistrationOutput>;

export const AgentMetaOutput = z.object({
  agent_id: z.string().uuid(),
  name: z.string(),
  agent_wallet_address: z.string(),
  description: z.string().nullable(),
  website: z.string().nullable(),
  tags: z.array(z.string()),
  created_at: z.number(),
  updated_at: z.number(),
});
export type AgentMetaOutput = z.infer<typeof AgentMetaOutput>;
