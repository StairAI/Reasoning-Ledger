import * as z from "zod";

// ---------------------------------------------------------------------------
// Agent request schemas
// ---------------------------------------------------------------------------

export const RegisterAgentInput = z.object({
  description: z.string().optional(),
  name: z.string().min(1).max(128),
  tags: z.array(z.string().max(64)).max(32).optional(),
  /** BYOW only — optional per-agent SUI address. Ignored in custodial mode. */
  wallet: z
    .object({
      address: z.string().min(1),
    })
    .optional(),
  website: z.string().url().optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInput>;

export const UpdateAgentInput = z.object({
  description: z.string().optional(),
  name: z.string().min(1).max(128).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  website: z.string().url().optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInput>;

// ---------------------------------------------------------------------------
// Agent response schemas
// ---------------------------------------------------------------------------

export const AgentRegistrationOutput = z.object({
  agent_id: z.string().uuid(),
  agent_wallet_address: z.string(),
  created_at: z.number(),
  name: z.string(), // epoch ms
});
export type AgentRegistrationOutput = z.infer<typeof AgentRegistrationOutput>;

export const AgentMetaOutput = z.object({
  agent_id: z.string().uuid(),
  agent_wallet_address: z.string(),
  created_at: z.number(),
  description: z.string().nullable(),
  name: z.string(),
  tags: z.array(z.string()),
  updated_at: z.number(),
  website: z.string().nullable(),
});
export type AgentMetaOutput = z.infer<typeof AgentMetaOutput>;
