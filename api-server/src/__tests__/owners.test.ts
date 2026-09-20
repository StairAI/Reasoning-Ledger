import { call } from "@orpc/server";
import { afterAll, beforeAll, describe, expect, it, expectTypeOf } from "vitest";
import { registerOwner, rotateKey, updateOwner } from "#/routes/owners";
import { resetRegistrationAttempts } from "#/lib/registration";
import { adminCtx, ctx, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

// ---------------------------------------------------------------------------
// POST /v1/owners
// ---------------------------------------------------------------------------

describe("POST /v1/owners — registerOwner", () => {
  const emails: string[] = [];

  afterAll(async () => {
    const { prisma } = await import("#/lib/prisma");
    for (const email of emails) {
      await prisma.owner.deleteMany({ where: { email } });
    }
  });

  it("creates a new custodial owner and returns a one-time api_key", async () => {
    const email = `test-reg-${crypto.randomUUID()}@example.com`;
    emails.push(email);

    const result = await call(registerOwner, { email, wallet_mode: "custodial" }, adminCtx());

    expect(result.owner_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.api_key).toMatch(/^sl_[0-9a-f]{64}$/);
    expect(result.wallet_mode).toBe("custodial");
    expect(result.owner_wallet_address).toMatch(/^0x[0-9a-f]{64}$/);
    expectTypeOf(result.created_at).toBeNumber();
  });

  it("is idempotent — second call returns metadata without api_key", async () => {
    const email = `test-idem-${crypto.randomUUID()}@example.com`;
    emails.push(email);

    const first = await call(registerOwner, { email, wallet_mode: "custodial" }, adminCtx());
    const second = await call(registerOwner, { email, wallet_mode: "custodial" }, adminCtx());

    expect(second.owner_id).toBe(first.owner_id);
    expect(second.api_key).toBeUndefined();
  });

  it("creates a byow owner with a supplied wallet address", async () => {
    const email = `test-byow-${crypto.randomUUID()}@example.com`;
    emails.push(email);
    const walletAddress = `0x${"b".repeat(64)}`;

    const result = await call(
      registerOwner,
      { email, owner_wallet_address: walletAddress, wallet_mode: "byow" },
      adminCtx(),
    );

    expect(result.wallet_mode).toBe("byow");
    expect(result.owner_wallet_address).toBe(walletAddress);
    expect(result.api_key).toMatch(/^sl_/);
  });

  it("rejects byow registration without a wallet address", async () => {
    const email = `test-byow-nw-${crypto.randomUUID()}@example.com`;
    emails.push(email);

    await expect(
      call(registerOwner, { email, wallet_mode: "byow" }, adminCtx()),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("stores optional fields (display_name, contact_email, website)", async () => {
    const email = `test-opt-${crypto.randomUUID()}@example.com`;
    emails.push(email);

    const result = await call(
      registerOwner,
      {
        contact_email: "contact@example.com",
        display_name: "Test Corp",
        email,
        wallet_mode: "custodial",
        website: "https://example.com",
      },
      adminCtx(),
    );

    expect(result.display_name).toBe("Test Corp");
    expect(result.contact_email).toBe("contact@example.com");
    expect(result.website).toBe("https://example.com");
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/owners/me
// ---------------------------------------------------------------------------

describe("PATCH /v1/owners/me — updateOwner", () => {
  let owner: TestOwner;

  beforeAll(async () => {
    owner = await makeTestOwner();
  });

  afterAll(async () => {
    await owner.cleanup();
  });

  it("updates display_name", async () => {
    const result = await call(updateOwner, { display_name: "Updated Name" }, ctx(owner.apiKey));

    expect(result.display_name).toBe("Updated Name");
    expect(result.owner_id).toBe(owner.ownerId);
    expectTypeOf(result.updated_at).toBeNumber();
  });

  it("updates contact_email", async () => {
    const result = await call(updateOwner, { contact_email: "new@example.com" }, ctx(owner.apiKey));

    expect(result.contact_email).toBe("new@example.com");
  });

  it("rejects requests with no valid api_key", async () => {
    await expect(
      call(updateOwner, { display_name: "Hack" }, ctx(`sl_${"0".repeat(64)}`)),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects requests with missing api_key", async () => {
    await expect(call(updateOwner, { display_name: "Hack" }, ctx())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/owners/me/rotate-key
// ---------------------------------------------------------------------------

describe("POST /v1/owners/me/rotate-key — rotateKey", () => {
  let owner: TestOwner;

  beforeAll(async () => {
    owner = await makeTestOwner();
  });

  afterAll(async () => {
    await owner.cleanup();
  });

  it("returns a new api_key with sl_ prefix", async () => {
    const result = await call(rotateKey, {}, ctx(owner.apiKey));

    expect(result.api_key).toMatch(/^sl_[0-9a-f]{64}$/);
    expect(result.api_key).not.toBe(owner.apiKey);
    // Keep owner in sync — next test needs the current valid key.
    owner = { ...owner, apiKey: result.api_key };
  });

  it("old key is immediately invalid after rotation", async () => {
    const oldKey = owner.apiKey;
    const { api_key: newKey } = await call(rotateKey, {}, ctx(oldKey));

    // Old key should now fail.
    await expect(call(rotateKey, {}, ctx(oldKey))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    // New key should work — rotate once more to confirm.
    const result2 = await call(rotateKey, {}, ctx(newKey));
    expect(result2.api_key).toMatch(/^sl_/);

    // Keep in sync so afterAll cleanup works without issues.
    owner = { ...owner, apiKey: result2.api_key };
  });
});

/** Context for a request arriving from the given client address. */
function from(ip: string) {
  return { context: { headers: { "cf-connecting-ip": ip } } };
}

describe("owner registration policy", () => {
  const cleanupEmails: string[] = [];

  afterAll(async () => {
    const { prisma } = await import("#/lib/prisma");
    await prisma.owner.deleteMany({ where: { email: { in: cleanupEmails } } });
    delete process.env.RL_REGISTRATION;
    delete process.env.RL_REGISTRATION_RATE;
    resetRegistrationAttempts();
  });

  function email() {
    const value = `policy-${crypto.randomUUID()}@example.com`;
    cleanupEmails.push(value);
    return value;
  }

  it("refuses registration without the administrator token by default", async () => {
    await expect(
      call(registerOwner, { email: email(), wallet_mode: "custodial" }, ctx()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a wrong administrator token", async () => {
    const wrong = { context: { headers: { "x-admin-token": "not-the-token" } } };
    await expect(
      call(registerOwner, { email: email(), wallet_mode: "custodial" }, wrong),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("checks the policy before looking up the e-mail, so it cannot be used to probe accounts", async () => {
    const known = email();
    await call(registerOwner, { email: known, wallet_mode: "custodial" }, adminCtx());
    await expect(
      call(registerOwner, { email: known, wallet_mode: "custodial" }, ctx()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows self-service in open mode, rate-limited per client address", async () => {
    process.env.RL_REGISTRATION = "open";
    process.env.RL_REGISTRATION_RATE = "2";
    resetRegistrationAttempts();

    await call(registerOwner, { email: email(), wallet_mode: "custodial" }, from("203.0.113.1"));
    await call(registerOwner, { email: email(), wallet_mode: "custodial" }, from("203.0.113.1"));
    await expect(
      call(registerOwner, { email: email(), wallet_mode: "custodial" }, from("203.0.113.1")),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    await call(registerOwner, { email: email(), wallet_mode: "custodial" }, from("203.0.113.2"));
  });
});
