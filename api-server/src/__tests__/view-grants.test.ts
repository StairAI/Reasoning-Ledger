import { call } from "@orpc/server";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptionForViewer } from "#/lib/content-view";
import { prisma } from "#/lib/prisma";
import type { ContentMap } from "#/lib/trace";
import { grantAllows, grantForToken } from "#/lib/view-grants";
import { VIZ_COOKIE, viewerForSession } from "#/lib/viz-session";
import { ALL, GET, HEAD } from "#/pages/session/grant/[token]";
import { putContentKey } from "#/routes/content-keys";
import { createViewGrant, listViewGrants, revokeViewGrant } from "#/routes/view-grants";
import { ctx, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

type RouteContext = Parameters<typeof GET>[0];

const masterKey = randomBytes(32);
const grantKey = randomBytes(32);

function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** AES-256-GCM, the key id as associated data: how the SDKs wrap a data key. */
function wrap(key: Buffer, data: Buffer, keyId: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(keyId));
  const sealed = Buffer.concat([nonce, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  return {
    master_key_id: keyIdOf(key),
    wrap_alg: "A256GCM" as const,
    wrapped_key: sealed.toString("base64"),
  };
}

/** Just enough of Astro's cookies for the grant page. */
function cookieJar(session?: string) {
  const set: { name: string; value: string }[] = [];
  return {
    cookies: {
      get: (name: string) => (name === VIZ_COOKIE && session ? { value: session } : undefined),
      set: (name: string, value: string) => {
        set.push({ name, value });
      },
    },
    set,
  };
}

async function open(token: string, session?: string) {
  const jar = cookieJar(session);
  const response = (await GET({
    cookies: jar.cookies,
    params: { token },
  } as unknown as RouteContext)) as Response;
  return { cookie: jar.set.find((c) => c.name === VIZ_COOKIE)?.value, response };
}

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

describe("view grants", () => {
  let owner: TestOwner;
  let other: TestOwner;
  const keys: { data: Buffer; key_id: string; session_id: string }[] = [];
  const grantKeys = (n: number) =>
    keys.slice(0, n).map((k) => ({ key_id: k.key_id, ...wrap(grantKey, k.data, k.key_id) }));

  beforeAll(async () => {
    owner = await makeTestOwner();
    other = await makeTestOwner();
    for (const sessionId of ["conv:t001", "conv:t002", "conv:t003"]) {
      const keyId = crypto.randomUUID();
      const data = randomBytes(32);
      await call(
        putContentKey,
        { key_id: keyId, session_id: sessionId, ...wrap(masterKey, data, keyId) },
        ctx(owner.apiKey),
      );
      keys.push({ data, key_id: keyId, session_id: sessionId });
    }
  });

  afterAll(async () => {
    await owner.cleanup();
    await other.cleanup();
  });

  it("opens the sessions of the keys it carries, for an hour, with keys wrapped under the grant key only", async () => {
    const grant = await call(createViewGrant, { keys: grantKeys(2) }, ctx(owner.apiKey));
    expect(grant.sessions).toBe(2);
    expect(grant.grant_url).toMatch(/^\/session\/grant\/[\w-]{40,}$/);
    expect(grant.expires_at - Date.now()).toBeGreaterThan(3_590_000);
    expect(grant.expires_at - Date.now()).toBeLessThanOrEqual(3_600_000);

    const { response, cookie } = await open(tokenOf(grant.grant_url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain('sessionStorage.setItem("rl_mk"');
    const viewer = await viewerForSession(cookie);
    expect(viewer?.ownerId).toBe(owner.ownerId);
    expect(viewer?.grant?.sessionIds).toStrictEqual(new Set(["conv:t001", "conv:t002"]));
    expect(grantAllows(viewer?.grant, "conv:t001")).toBeTruthy();
    expect(grantAllows(viewer?.grant, "conv:t003")).toBeFalsy();
    expect(grantAllows(undefined, "conv:t003")).toBeTruthy();

    // The pages give the browser the grant's copy of a key, and nothing for a session outside the grant.
    const object = {
      alg: "A256GCM",
      bytes: 1,
      ciphertext: "x",
      media_type: "text/plain",
      state: "encrypted",
    };
    const contents = {
      a: { ...object, key_id: keys[0].key_id },
      c: { ...object, key_id: keys[2].key_id },
    } as unknown as ContentMap;
    const page = await encryptionForViewer(owner.ownerId, contents, viewer?.grant?.keys);
    expect(Object.keys(page.keys)).toStrictEqual([keys[0].key_id]);
    expect(page.keys[keys[0].key_id].master_key_id).toBe(keyIdOf(grantKey));
    const ownerPage = await encryptionForViewer(owner.ownerId, contents);
    expect(Object.values(ownerPage.keys).map((k) => k.master_key_id)).toStrictEqual([
      keyIdOf(masterKey),
      keyIdOf(masterKey),
    ]);

    // The link can be opened again until the grant ends; HEAD and other methods open nothing.
    const reopened = await open(tokenOf(grant.grant_url));
    expect(reopened.response.status).toBe(200);
    const head = (await HEAD({
      params: { token: tokenOf(grant.grant_url) },
    } as unknown as RouteContext)) as Response;
    expect(head.status).toBe(200);
    const posted = (await ALL({} as unknown as RouteContext)) as Response;
    expect(posted.status).toBe(405);
  });

  it("takes only the owner's keys, wrapped under one grant key that is not the master key", async () => {
    const unknown = crypto.randomUUID();
    await expect(
      call(
        createViewGrant,
        { keys: [{ key_id: unknown, ...wrap(grantKey, randomBytes(32), unknown) }] },
        ctx(owner.apiKey),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(createViewGrant, { keys: grantKeys(1) }, ctx(other.apiKey)),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const underMaster = [
      { key_id: keys[0].key_id, ...wrap(masterKey, keys[0].data, keys[0].key_id) },
    ];
    await expect(
      call(createViewGrant, { keys: underMaster }, ctx(owner.apiKey)),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const mixed = [
      grantKeys(1)[0],
      { key_id: keys[1].key_id, ...wrap(randomBytes(32), keys[1].data, keys[1].key_id) },
    ];
    await expect(call(createViewGrant, { keys: mixed }, ctx(owner.apiKey))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("ends when revoked or expired: its keys are dropped and the browsers it opened are signed out", async () => {
    const grant = await call(createViewGrant, { keys: grantKeys(1) }, ctx(owner.apiKey));
    const { cookie } = await open(tokenOf(grant.grant_url));
    await expect(viewerForSession(cookie)).resolves.toBeDefined();
    // Another owner cannot end it.
    await expect(
      call(revokeViewGrant, { grant_id: grant.grant_id }, ctx(other.apiKey)),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(revokeViewGrant, { grant_id: grant.grant_id }, ctx(owner.apiKey)),
    ).resolves.toStrictEqual({
      revoked: true,
    });
    await expect(grantForToken(tokenOf(grant.grant_url))).resolves.toBeNull();
    await expect(viewerForSession(cookie)).resolves.toBeUndefined();
    const revoked = await prisma.viewGrant.findUnique({ where: { id: grant.grant_id } });
    expect(revoked?.keys).toStrictEqual({});
    expect(revoked?.revoked_at).not.toBeNull();
    const again = await open(tokenOf(grant.grant_url));
    expect(again.response.status).toBe(410);
    expect(again.cookie).toBeUndefined();

    const later = await call(
      createViewGrant,
      { expires_in: 60, keys: grantKeys(1) },
      ctx(owner.apiKey),
    );
    const opened = await open(tokenOf(later.grant_url));
    await prisma.viewGrant.update({
      data: { expires_at: new Date(Date.now() - 1000) },
      where: { id: later.grant_id },
    });
    await expect(viewerForSession(opened.cookie)).resolves.toBeUndefined();
    await expect(grantForToken(tokenOf(later.grant_url))).resolves.toBeNull();
    const expired = await prisma.viewGrant.findUnique({ where: { id: later.grant_id } });
    expect(expired?.keys).toStrictEqual({});
    expect(expired?.ended_at).not.toBeNull();

    // The list says what was granted and when it ended, never the keys; another owner sees none of it.
    const { grants } = await call(listViewGrants, undefined, ctx(owner.apiKey));
    expect(grants.find((g) => g.grant_id === later.grant_id)).toMatchObject({
      purpose: "view",
      sessions: 1,
    });
    expect(JSON.stringify(grants)).not.toContain("wrapped_key");
    const othersGrants = await call(listViewGrants, undefined, ctx(other.apiKey));
    expect(othersGrants.grants).toStrictEqual([]);
  });
});
