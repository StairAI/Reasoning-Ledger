import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it, expectTypeOf } from "vitest";
import { getAgent, registerAgent, resolveAgent, updateAgent } from "#/routes/agents";
import { ctx, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

describe("Agents", () => {
  let owner: TestOwner;
  let ownerB: TestOwner; // second owner — isolation checks

  beforeAll(async () => {
    [owner, ownerB] = await Promise.all([makeTestOwner(), makeTestOwner()]);
  });

  afterAll(async () => {
    await Promise.all([owner.cleanup(), ownerB.cleanup()]);
  });

  // -------------------------------------------------------------------------
  // POST /v1/agents — registerAgent
  // -------------------------------------------------------------------------

  describe(registerAgent, () => {
    it("creates an agent and returns registration info", async () => {
      const result = await call(
        registerAgent,
        { name: `agent-${crypto.randomUUID()}` },
        ctx(owner.apiKey),
      );

      expect(result.agent_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.name).toMatch(/^agent-/);
      expect(result.agent_wallet_address).toMatch(/^0x[0-9a-f]{64}$/);
      expectTypeOf(result.created_at).toBeNumber();
    });

    it("is idempotent on (owner, name) — returns same agent_id", async () => {
      const name = `idem-${crypto.randomUUID()}`;
      const first = await call(registerAgent, { name }, ctx(owner.apiKey));
      const second = await call(registerAgent, { name }, ctx(owner.apiKey));

      expect(second.agent_id).toBe(first.agent_id);
    });

    it("two different owners can register agents with the same name", async () => {
      const name = `shared-name-${crypto.randomUUID()}`;
      const a = await call(registerAgent, { name }, ctx(owner.apiKey));
      const b = await call(registerAgent, { name }, ctx(ownerB.apiKey));

      expect(a.agent_id).not.toBe(b.agent_id);
    });

    it("accepts optional description, website, tags", async () => {
      const result = await call(
        registerAgent,
        {
          description: "A test agent",
          name: `full-${crypto.randomUUID()}`,
          tags: ["qa", "integration"],
          website: "https://agent.example.com",
        },
        ctx(owner.apiKey),
      );

      expect(result.agent_id).toBeDefined();
    });

    it("rejects unauthenticated requests", async () => {
      await expect(call(registerAgent, { name: "anon" }, ctx())).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/agents?name= — resolveAgent
  // -------------------------------------------------------------------------

  describe(resolveAgent, () => {
    it("resolves a registered agent by name", async () => {
      const name = `resolve-${crypto.randomUUID()}`;
      const reg = await call(registerAgent, { name }, ctx(owner.apiKey));
      const resolved = await call(resolveAgent, { name }, ctx(owner.apiKey));

      expect(resolved.agent_id).toBe(reg.agent_id);
      expect(resolved.name).toBe(name);
      expect(resolved.tags).toStrictEqual([]);
      expect(resolved.description).toBeNull();
    });

    it("returns NOT_FOUND for an unknown name", async () => {
      await expect(
        call(resolveAgent, { name: "does-not-exist" }, ctx(owner.apiKey)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("is scoped to the calling owner — cannot resolve another owner's agent", async () => {
      const name = `cross-${crypto.randomUUID()}`;
      await call(registerAgent, { name }, ctx(owner.apiKey));

      await expect(call(resolveAgent, { name }, ctx(ownerB.apiKey))).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  });

  // -------------------------------------------------------------------------
  // GET /v1/agents/:agent_id — getAgent
  // -------------------------------------------------------------------------

  describe(getAgent, () => {
    it("fetches agent metadata by id", async () => {
      const name = `get-${crypto.randomUUID()}`;
      const reg = await call(registerAgent, { name }, ctx(owner.apiKey));
      const meta = await call(getAgent, { agent_id: reg.agent_id }, ctx(owner.apiKey));

      expect(meta.agent_id).toBe(reg.agent_id);
      expect(meta.name).toBe(name);
      expectTypeOf(meta.updated_at).toBeNumber();
    });

    it("returns NOT_FOUND for an agent owned by a different owner", async () => {
      const reg = await call(
        registerAgent,
        { name: `cross-${crypto.randomUUID()}` },
        ctx(owner.apiKey),
      );

      await expect(
        call(getAgent, { agent_id: reg.agent_id }, ctx(ownerB.apiKey)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("returns NOT_FOUND for a random unknown UUID", async () => {
      await expect(
        call(getAgent, { agent_id: crypto.randomUUID() }, ctx(owner.apiKey)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /v1/agents/:agent_id — updateAgent
  // -------------------------------------------------------------------------

  describe(updateAgent, () => {
    it("updates agent name", async () => {
      const original = `upd-${crypto.randomUUID()}`;
      const reg = await call(registerAgent, { name: original }, ctx(owner.apiKey));
      const newName = `renamed-${crypto.randomUUID()}`;

      const updated = await call(
        updateAgent,
        { agent_id: reg.agent_id, name: newName },
        ctx(owner.apiKey),
      );

      expect(updated.name).toBe(newName);
      expect(updated.agent_wallet_address).toBe(reg.agent_wallet_address); // immutable
    });

    it("updates description, website, and tags independently", async () => {
      const reg = await call(
        registerAgent,
        { name: `partial-${crypto.randomUUID()}` },
        ctx(owner.apiKey),
      );

      const updated = await call(
        updateAgent,
        {
          agent_id: reg.agent_id,
          description: "Updated desc",
          tags: ["new-tag"],
          website: "https://updated.example.com",
        },
        ctx(owner.apiKey),
      );

      expect(updated.description).toBe("Updated desc");
      expect(updated.tags).toStrictEqual(["new-tag"]);
      expect(updated.website).toBe("https://updated.example.com");
    });

    it("returns CONFLICT when renaming to an existing agent's name", async () => {
      const nameA = `conflict-a-${crypto.randomUUID()}`;
      const nameB = `conflict-b-${crypto.randomUUID()}`;
      const regA = await call(registerAgent, { name: nameA }, ctx(owner.apiKey));
      await call(registerAgent, { name: nameB }, ctx(owner.apiKey));

      await expect(
        call(updateAgent, { agent_id: regA.agent_id, name: nameB }, ctx(owner.apiKey)),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("returns NOT_FOUND when updating another owner's agent", async () => {
      const reg = await call(
        registerAgent,
        { name: `own-${crypto.randomUUID()}` },
        ctx(owner.apiKey),
      );

      await expect(
        call(updateAgent, { agent_id: reg.agent_id, name: "steal" }, ctx(ownerB.apiKey)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
