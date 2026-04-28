import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { prisma } from "#/lib/prisma";
import { generateWalletAddress } from "#/lib/wallet";
import { authed } from "#/lib/auth";
import { RegisterAgentInput, UpdateAgentInput } from "#/schemas/agents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentToRegistration(agent: {
  id: string;
  name: string;
  agent_wallet_address: string;
  created_at: Date;
}) {
  return {
    agent_id: agent.id,
    agent_wallet_address: agent.agent_wallet_address,
    created_at: agent.created_at.getTime(),
    name: agent.name,
  };
}

function agentToMeta(agent: {
  id: string;
  name: string;
  agent_wallet_address: string;
  description: string | null;
  website: string | null;
  tags: string[];
  created_at: Date;
  updated_at: Date;
}) {
  return {
    agent_id: agent.id,
    agent_wallet_address: agent.agent_wallet_address,
    created_at: agent.created_at.getTime(),
    description: agent.description,
    name: agent.name,
    tags: agent.tags,
    updated_at: agent.updated_at.getTime(),
    website: agent.website,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/agents
// Register a new agent under the calling owner.
// Idempotent on (owner, name) — returns existing agent without side effects.
// ---------------------------------------------------------------------------

export const registerAgent = authed
  .route({ method: "POST", path: "/v1/agents" })
  .input(RegisterAgentInput)
  .output(
    z.object({
      agent_id: z.string(),
      agent_wallet_address: z.string(),
      created_at: z.number(),
      name: z.string(),
    }),
  )
  .handler(async ({ input, context }) => {
    // Idempotency: (owner_id, name) is a unique constraint.
    const existing = await prisma.agent.findUnique({
      where: { owner_id_name: { name: input.name, owner_id: context.ownerId } },
    });

    if (existing) {
      // Return existing agent; ignore wallet field on repeat calls per spec §6.5.
      return agentToRegistration(existing);
    }

    // Determine wallet address.
    let walletAddress: string;
    if (context.walletMode === "byow") {
      if (input.wallet?.address) {
        walletAddress = input.wallet.address;
      } else {
        // Fall back to the owner's default wallet address.
        const owner = await prisma.owner.findUniqueOrThrow({
          select: { owner_wallet_address: true },
          where: { id: context.ownerId },
        });
        walletAddress = owner.owner_wallet_address;
      }
    } else {
      // Custodial: generate a fresh per-agent address.
      walletAddress = generateWalletAddress();
    }

    const agent = await prisma.agent.create({
      data: {
        agent_wallet_address: walletAddress,
        description: input.description,
        name: input.name,
        owner_id: context.ownerId,
        tags: input.tags ?? [],
        website: input.website,
      },
    });

    return agentToRegistration(agent);
  });

// ---------------------------------------------------------------------------
// GET /v1/agents?name=...
// Resolve an agent by human-readable name within the calling owner's scope.
// Backs LedgerClient.resolveAgentId().
// ---------------------------------------------------------------------------

export const resolveAgent = authed
  .route({ method: "GET", path: "/v1/agents" })
  .input(z.object({ name: z.string().min(1) }))
  .output(
    z.object({
      agent_id: z.string(),
      agent_wallet_address: z.string(),
      created_at: z.number(),
      description: z.string().nullable(),
      name: z.string(),
      tags: z.array(z.string()),
      updated_at: z.number(),
      website: z.string().nullable(),
    }),
  )
  .handler(async ({ input, context }) => {
    const agent = await prisma.agent.findUnique({
      where: { owner_id_name: { name: input.name, owner_id: context.ownerId } },
    });

    if (!agent) {
      throw new ORPCError("NOT_FOUND", {
        message: `No agent named '${input.name}' found for this owner`,
      });
    }

    return agentToMeta(agent);
  });

// ---------------------------------------------------------------------------
// GET /v1/agents/:agent_id
// Fetch public metadata for a specific agent.
// Verifies the agent belongs to the calling owner.
// ---------------------------------------------------------------------------

export const getAgent = authed
  .route({ method: "GET", path: "/v1/agents/{agent_id}" })
  .input(z.object({ agent_id: z.string().uuid() }))
  .output(
    z.object({
      agent_id: z.string(),
      agent_wallet_address: z.string(),
      created_at: z.number(),
      description: z.string().nullable(),
      name: z.string(),
      tags: z.array(z.string()),
      updated_at: z.number(),
      website: z.string().nullable(),
    }),
  )
  .handler(async ({ input, context }) => {
    const agent = await prisma.agent.findUnique({
      where: { id: input.agent_id },
    });

    if (!agent || agent.owner_id !== context.ownerId) {
      throw new ORPCError("NOT_FOUND", {
        message: "Agent not found",
      });
    }

    return agentToMeta(agent);
  });

// ---------------------------------------------------------------------------
// PATCH /v1/agents/:agent_id
// Update mutable metadata for an agent.
// ---------------------------------------------------------------------------

export const updateAgent = authed
  .route({ method: "PATCH", path: "/v1/agents/{agent_id}" })
  .input(z.object({ agent_id: z.string().uuid() }).merge(UpdateAgentInput))
  .output(
    z.object({
      agent_id: z.string(),
      agent_wallet_address: z.string(),
      created_at: z.number(),
      description: z.string().nullable(),
      name: z.string(),
      tags: z.array(z.string()),
      updated_at: z.number(),
      website: z.string().nullable(),
    }),
  )
  .handler(async ({ input, context }) => {
    // Verify ownership before mutating.
    const existing = await prisma.agent.findUnique({ where: { id: input.agent_id } });
    if (!existing || existing.owner_id !== context.ownerId) {
      throw new ORPCError("NOT_FOUND", { message: "Agent not found" });
    }

    // If renaming, check uniqueness within owner.
    if (input.name && input.name !== existing.name) {
      const conflict = await prisma.agent.findUnique({
        where: { owner_id_name: { name: input.name, owner_id: context.ownerId } },
      });
      if (conflict) {
        throw new ORPCError("CONFLICT", {
          message: `An agent named '${input.name}' already exists for this owner`,
        });
      }
    }

    const agent = await prisma.agent.update({
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.website !== undefined && { website: input.website }),
        ...(input.tags !== undefined && { tags: input.tags }),
      },
      where: { id: input.agent_id },
    });

    return agentToMeta(agent);
  });

// ---------------------------------------------------------------------------
// Router group
// ---------------------------------------------------------------------------

export const agentsRouter = {
  getAgent,
  registerAgent,
  resolveAgent,
  updateAgent,
};
