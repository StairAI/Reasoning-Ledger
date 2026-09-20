import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "#/lib/prisma";
import {
  endVizSession,
  fromThisSite,
  ownerForVizSession,
  safeNext,
  startVizSession,
  vizCookieOptions,
} from "#/lib/viz-session";
import { makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

describe("Visualiser login sessions", () => {
  let owner: TestOwner;

  beforeAll(async () => {
    owner = await makeTestOwner();
  });

  afterAll(async () => {
    await owner.cleanup();
  });

  it("resolves a started session to its owner until it ends", async () => {
    const session = await startVizSession(owner.ownerId);
    expect(session.id).toMatch(/^[0-9a-f]{64}$/);
    await expect(ownerForVizSession(session.id)).resolves.toBe(owner.ownerId);

    await endVizSession(session.id);
    await expect(ownerForVizSession(session.id)).resolves.toBeUndefined();
  });

  it("treats a missing or unknown cookie as signed out", async () => {
    await expect(ownerForVizSession()).resolves.toBeUndefined();
    await expect(ownerForVizSession("0".repeat(64))).resolves.toBeUndefined();
  });

  it("drops an expired session", async () => {
    const session = await startVizSession(owner.ownerId);
    await prisma.vizSession.update({
      data: { expires_at: new Date(Date.now() - 1000) },
      where: { id: session.id },
    });
    await expect(ownerForVizSession(session.id)).resolves.toBeUndefined();
    await expect(prisma.vizSession.findUnique({ where: { id: session.id } })).resolves.toBeNull();
  });

  it("sets the cookie HttpOnly, Secure and SameSite=Strict", () => {
    const options = vizCookieOptions(new Date());
    expect(options).toMatchObject({ httpOnly: true, path: "/", sameSite: "strict", secure: true });
  });
});

describe("Sign-in redirect target", () => {
  it("keeps paths on this site", () => {
    expect(safeNext("/traces/a/b?x=1#top")).toBe("/traces/a/b?x=1#top");
    expect(safeNext("/")).toBe("/");
  });

  it("never leaves the site", () => {
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "https://evil.example/",
      "evil.example",
      "",
      null,
    ]) {
      expect(safeNext(next)).toBe("/");
    }
  });
});

function post(headers: Record<string, string>) {
  return new Request("http://127.0.0.1:4321/session", { headers, method: "POST" });
}

describe("Sign-in and sign-out origin check", () => {
  it("accepts a post from a page of this site", () => {
    expect(fromThisSite(post({ "sec-fetch-site": "same-origin" }))).toBeTruthy();
    // Behind a TLS-terminating proxy the browser's origin is https while the server sees http.
    expect(
      fromThisSite(post({ host: "ledger.example.com", origin: "https://ledger.example.com" })),
    ).toBeTruthy();
  });

  it("rejects a post from another site, or one that does not say where it comes from", () => {
    expect(fromThisSite(post({ "sec-fetch-site": "cross-site" }))).toBeFalsy();
    expect(fromThisSite(post({ "sec-fetch-site": "same-site" }))).toBeFalsy();
    expect(
      fromThisSite(post({ host: "ledger.example.com", origin: "https://evil.example" })),
    ).toBeFalsy();
    expect(fromThisSite(post({ host: "ledger.example.com" }))).toBeFalsy();
    expect(fromThisSite(post({ host: "ledger.example.com", origin: "null" }))).toBeFalsy();
  });
});
