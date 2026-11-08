import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isAdminToken, mayManageInvites, mayRegisterOwners } from "#/lib/admin";
import { generateInviteCode, inviteProblem, normalizeInviteCode } from "#/lib/invites";
import { prisma } from "#/lib/prisma";
import { resetRegistrationAttempts } from "#/lib/registration";
import { lookupOwner } from "#/routes/access";
import {
  createInviteCodes,
  listInviteCodes,
  revokeInviteCode,
  updateInviteCode,
} from "#/routes/admin";
import { registerOwner } from "#/routes/owners";
import { listSessions } from "#/routes/traces";
import { TEST_ADMIN_TOKEN, adminCtx, call } from "./helpers";

/** A self-service caller: no token, a fixed client address. */
function visitor(address = "203.0.113.7") {
  return { context: { headers: { "cf-connecting-ip": address } } };
}

/** A caller holding some token in X-Admin-Token, as an application would. */
function holding(token: string) {
  return { context: { headers: { "x-admin-token": token } } };
}

const INVITES_TOKEN = `test-invites-${crypto.randomUUID()}`;
const REGISTRATION_TOKEN = `test-registration-${crypto.randomUUID()}`;

describe("invite codes", () => {
  const emails: string[] = [];
  const codes: string[] = [];
  const ownerIds: string[] = [];
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
    await prisma.owner.deleteMany({
      where: { OR: [{ email: { in: emails } }, { id: { in: ownerIds } }] },
    });
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

  it("the invites token makes, lists, edits and revokes codes, and opens nothing else", async () => {
    process.env.RL_INVITES_TOKEN = INVITES_TOKEN;
    process.env.RL_REGISTRATION_TOKEN = REGISTRATION_TOKEN;
    try {
      const app = holding(INVITES_TOKEN);
      const made = await call(createInviteCodes, { count: 1, note: "for the page" }, app);
      codes.push(...made.invites.map((i) => i.code));
      const [invite] = made.invites;
      const { invites } = await call(listInviteCodes, undefined, app);
      expect(invites.map((i) => i.code)).toContain(invite.code);
      const noted = await call(updateInviteCode, { code: invite.code, note: "for Ada" }, app);
      expect(noted.note).toBe("for Ada");
      const revoked = await call(revokeInviteCode, { code: invite.code }, app);
      expect(revoked.revoked_at).not.toBeNull();

      // It reads no records, takes no other administrator route, registers
      // nobody, and is not the administrator anywhere (the content route and
      // the viewer's sign-in ask isAdminToken).
      await expect(call(listSessions, { limit: 10 }, app)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(call(lookupOwner, { email: "nobody@example.com" }, app)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      process.env.RL_REGISTRATION = "admin";
      await expect(
        call(registerOwner, { email: email("invites-token") }, app),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      process.env.RL_REGISTRATION = "invite";
      expect(isAdminToken(INVITES_TOKEN)).toBeFalsy();
      expect(mayRegisterOwners({ "x-admin-token": INVITES_TOKEN })).toBeFalsy();

      // The registration token still has no say over codes; the administrator's still does.
      const registrar = holding(REGISTRATION_TOKEN);
      await expect(call(listInviteCodes, undefined, registrar)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(
        call(updateInviteCode, { code: invite.code, note: null }, registrar),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const byAdmin = await call(updateInviteCode, { code: invite.code, note: null }, adminCtx());
      expect(byAdmin.note).toBeNull();
    } finally {
      process.env.RL_REGISTRATION = "invite";
      Reflect.deleteProperty(process.env, "RL_INVITES_TOKEN");
      Reflect.deleteProperty(process.env, "RL_REGISTRATION_TOKEN");
    }

    // Unset, the variable opens nothing: the same value is refused, as before it existed.
    await expect(call(listInviteCodes, undefined, holding(INVITES_TOKEN))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(mayManageInvites({})).toBeFalsy();
    expect(mayManageInvites({ "x-admin-token": "" })).toBeFalsy();
  });

  it("a code's note can be changed or cleared; the code is found without case, an unknown one is not", async () => {
    const [invite] = await mint({ count: 1, note: "first batch" });
    const changed = await call(
      updateInviteCode,
      { code: ` ${invite.code.toLowerCase()} `, note: "  for Grace  " },
      adminCtx(),
    );
    expect(changed).toMatchObject({
      code: invite.code,
      max_uses: 1,
      note: "for Grace",
      revoked_at: null,
      uses: 0,
    });
    const blank = await call(updateInviteCode, { code: invite.code, note: "   " }, adminCtx());
    expect(blank.note).toBeNull();
    const again = await call(updateInviteCode, { code: invite.code, note: "again" }, adminCtx());
    expect(again.note).toBe("again");
    const cleared = await call(updateInviteCode, { code: invite.code, note: null }, adminCtx());
    expect(cleared.note).toBeNull();

    // A revoked code keeps its revocation when its note changes.
    const revoked = await call(revokeInviteCode, { code: invite.code }, adminCtx());
    const relabelled = await call(
      updateInviteCode,
      { code: invite.code, note: "kept for the record" },
      adminCtx(),
    );
    expect(relabelled).toMatchObject({
      note: "kept for the record",
      revoked_at: revoked.revoked_at,
    });

    await expect(
      call(updateInviteCode, { code: "STAIR-NOPE1-NOPE2", note: "x" }, adminCtx()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(updateInviteCode, { code: invite.code, note: "x".repeat(201) }, adminCtx()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const row = await prisma.invite.findUnique({ where: { code: invite.code } });
    expect(row?.note).toBe("kept for the record");
  });

  it("every code lists the owners it admitted, first registered first", async () => {
    const [invite] = await mint({ count: 1, max_uses: 3 });
    const [unused] = await mint({ count: 1 });
    expect(invite.owners).toStrictEqual([]);

    const named = email("owner-named");
    const first = await call(registerOwner, { email: named, invite_code: invite.code }, visitor());
    const second = await call(registerOwner, { invite_code: invite.code.toLowerCase() }, visitor());
    ownerIds.push(first.owner_id, second.owner_id);
    // Registered the other way round: the anonymous owner an hour earlier.
    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.owner.update({ data: { created_at: earlier }, where: { id: second.owner_id } });

    const { invites } = await call(listInviteCodes, undefined, adminCtx());
    const listed = invites.find((i) => i.code === invite.code);
    expect(listed?.owners).toStrictEqual([
      { created_at: earlier.getTime(), email: null, owner_id: second.owner_id },
      { created_at: first.created_at, email: named, owner_id: first.owner_id },
    ]);
    expect(listed?.uses).toBe(2);
    expect(invites.find((i) => i.code === unused.code)?.owners).toStrictEqual([]);

    // Every answer about one code carries the same list.
    const noted = await call(
      updateInviteCode,
      { code: invite.code, note: "two of them" },
      adminCtx(),
    );
    expect(noted.owners).toStrictEqual(listed?.owners);
    const revoked = await call(revokeInviteCode, { code: invite.code }, adminCtx());
    expect(revoked.owners).toStrictEqual(listed?.owners);
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
