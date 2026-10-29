import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateInviteCode, inviteProblem, normalizeInviteCode } from "#/lib/invites";
import { prisma } from "#/lib/prisma";
import { resetRegistrationAttempts } from "#/lib/registration";
import { createInviteCodes, listInviteCodes, revokeInviteCode } from "#/routes/admin";
import { registerOwner } from "#/routes/owners";
import { TEST_ADMIN_TOKEN, adminCtx, call } from "./helpers";

/** A self-service caller: no token, a fixed client address. */
function visitor(address = "203.0.113.7") {
  return { context: { headers: { "cf-connecting-ip": address } } };
}

describe("invite codes", () => {
  const emails: string[] = [];
  const codes: string[] = [];
  const email = (tag: string) => {
    const value = `test-invite-${tag}-${crypto.randomUUID()}@example.com`;
    emails.push(value);
    return value;
  };
  const originalMode = process.env.RL_REGISTRATION;

  beforeAll(() => {
    process.env.RL_REGISTRATION = "invite";
    process.env.RL_REGISTRATION_RATE = "100";
  });

  afterEach(() => resetRegistrationAttempts());

  afterAll(async () => {
    if (originalMode === undefined) {
      delete process.env.RL_REGISTRATION;
    } else {
      process.env.RL_REGISTRATION = originalMode;
    }
    delete process.env.RL_REGISTRATION_RATE;
    await prisma.owner.deleteMany({ where: { email: { in: emails } } });
    await prisma.invite.deleteMany({ where: { code: { in: codes } } });
  });

  async function mint(input?: {
    count?: number;
    expires_in_days?: number;
    max_uses?: number;
    note?: string;
  }) {
    const { invites } = await call(createInviteCodes, input, adminCtx());
    codes.push(...invites.map((i) => i.code));
    return invites;
  }

  it("makes codes that read well and compare without case", () => {
    const code = generateInviteCode();
    expect(code).toMatch(
      /^STAIR-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}$/,
    );
    expect(normalizeInviteCode(` ${code.toLowerCase()} `)).toBe(code);
    expect(inviteProblem(null)).toBe("unknown");
  });

  it("only the administrator makes, lists and revokes codes", async () => {
    await expect(call(createInviteCodes, undefined, visitor())).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      call(listInviteCodes, undefined, {
        context: { headers: { "x-admin-token": `${TEST_ADMIN_TOKEN}-not` } },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const [invite] = await mint({ count: 1, max_uses: 2, note: "for the test" });
    expect(invite).toMatchObject({ max_uses: 2, note: "for the test", revoked_at: null, uses: 0 });
    const { invites } = await call(listInviteCodes, undefined, adminCtx());
    expect(invites.map((i) => i.code)).toContain(invite.code);
  });

  it("in invite mode a registration needs a code; a code admits its uses and no more", async () => {
    await expect(call(registerOwner, { email: email("nocode") }, visitor())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("needs an invite code"),
    });
    await expect(
      call(registerOwner, { email: email("bad"), invite_code: "STAIR-NOPE1-NOPE2" }, visitor()),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "This invite code is unknown",
    });

    const [invite] = await mint({ count: 1, max_uses: 1 });
    const admitted = await call(
      registerOwner,
      { email: email("ok"), invite_code: invite.code.toLowerCase() },
      visitor(),
    );
    expect(admitted.api_key).toMatch(/^sl_/);
    const row = await prisma.owner.findUnique({ where: { id: admitted.owner_id } });
    expect(row?.invite_code).toBe(invite.code);
    const spent = await prisma.invite.findUnique({ where: { code: invite.code } });
    expect(spent?.uses).toBe(1);

    await expect(
      call(registerOwner, { email: email("late"), invite_code: invite.code }, visitor()),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "This invite code is used up",
    });
  });

  it("an expired or revoked code admits nobody; revoking is idempotent", async () => {
    const [expired] = await mint({ count: 1, expires_in_days: 1 });
    await prisma.invite.update({
      data: { expires_at: new Date(Date.now() - 1000) },
      where: { code: expired.code },
    });
    await expect(
      call(registerOwner, { email: email("expired"), invite_code: expired.code }, visitor()),
    ).rejects.toMatchObject({
      message: "This invite code is expired",
    });

    const [revoked] = await mint({ count: 1 });
    const once = await call(revokeInviteCode, { code: revoked.code }, adminCtx());
    const twice = await call(revokeInviteCode, { code: revoked.code.toLowerCase() }, adminCtx());
    expect(once.revoked_at).toBe(twice.revoked_at);
    await expect(
      call(registerOwner, { email: email("revoked"), invite_code: revoked.code }, visitor()),
    ).rejects.toMatchObject({
      message: "This invite code is revoked",
    });
    await expect(
      call(revokeInviteCode, { code: "STAIR-NOPE1-NOPE2" }, adminCtx()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the operator's token registers without a code; a code given with it is still spent and recorded", async () => {
    const byToken = await call(registerOwner, { email: email("token") }, adminCtx());
    expect(byToken.api_key).toMatch(/^sl_/);
    const [invite] = await mint({ count: 1 });
    const attributed = await call(
      registerOwner,
      { email: email("token-code"), invite_code: invite.code },
      adminCtx(),
    );
    const row = await prisma.owner.findUnique({ where: { id: attributed.owner_id } });
    expect(row?.invite_code).toBe(invite.code);
  });

  it("a second registration of the same e-mail does not spend a use, but a bad code is still refused", async () => {
    const [invite] = await mint({ count: 1, max_uses: 2 });
    const same = email("again");
    const first = await call(registerOwner, { email: same, invite_code: invite.code }, visitor());
    const again = await call(registerOwner, { email: same, invite_code: invite.code }, visitor());
    expect(again.owner_id).toBe(first.owner_id);
    expect(again.api_key).toBeUndefined();
    const spent = await prisma.invite.findUnique({ where: { code: invite.code } });
    expect(spent?.uses).toBe(1);
    await expect(
      call(registerOwner, { email: same, invite_code: "STAIR-NOPE1-NOPE2" }, visitor()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("in open mode a code is optional, and recorded when given", async () => {
    process.env.RL_REGISTRATION = "open";
    const free = await call(registerOwner, { email: email("open") }, visitor("203.0.113.9"));
    expect(free.api_key).toMatch(/^sl_/);
    const [invite] = await mint({ count: 1 });
    const attributed = await call(
      registerOwner,
      { email: email("open-code"), invite_code: invite.code },
      visitor("203.0.113.9"),
    );
    const row = await prisma.owner.findUnique({ where: { id: attributed.owner_id } });
    expect(row?.invite_code).toBe(invite.code);
    process.env.RL_REGISTRATION = "invite";
  });
});
