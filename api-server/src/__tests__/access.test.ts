import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  API_KEY_TOKEN_TYPE,
  TOKEN_EXCHANGE,
  accessConfig,
  canonicalResource,
  handleProblem,
} from "#/lib/access";
import { prisma } from "#/lib/prisma";
import { GET as wellKnownJwks } from "#/pages/.well-known/jwks.json";
import { GET as wellKnownMetadata } from "#/pages/.well-known/oauth-authorization-server";
import { GET as accessMe } from "#/pages/access/me";
import { POST as accessToken } from "#/pages/access/token";
import {
  createAccessGrant,
  listAccessGrants,
  lookupOwner,
  revokeAccessGrant,
  setOwnerHandle,
} from "#/routes/access";
import { adminCtx, call, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

type RouteContext = Parameters<typeof accessToken>[0];

const ISSUER = "https://access.example.test";
const SHARE = "https://share.example.test";

function newKey(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ format: "der", type: "pkcs8" })
    .toString("base64");
}

function thumbprint(der: string): string {
  const key = createPublicKey(
    createPrivateKey({ format: "der", key: Buffer.from(der, "base64"), type: "pkcs8" }),
  );
  const { crv, kty, x } = key.export({ format: "jwk" }) as { crv: string; kty: string; x: string };
  return createHash("sha256").update(JSON.stringify({ crv, kty, x })).digest("base64url");
}

function route(handler: typeof accessToken, request: Request) {
  return handler({ request } as unknown as RouteContext) as Promise<Response>;
}

function tokenRequest(
  fields: Record<string, string | string[]>,
  type = "application/x-www-form-urlencoded",
) {
  const form = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      form.append(name, one);
    }
  }
  return route(
    accessToken,
    new Request("http://localhost/access/token", {
      body: form.toString(),
      headers: { "content-type": type },
      method: "POST",
    }),
  );
}

function exchange(key: string, extra: Record<string, string | string[]> = {}) {
  return tokenRequest({
    grant_type: TOKEN_EXCHANGE,
    resource: SHARE,
    subject_token: key,
    subject_token_type: API_KEY_TOKEN_TYPE,
    ...extra,
  });
}

async function body<T = Record<string, unknown>>(
  pending: Promise<Response> | Response,
): Promise<T> {
  const response = await pending;
  const parsed: unknown = await response.json();
  return parsed as T;
}

async function errorOf(pending: Promise<Response>): Promise<string> {
  const parsed = await body<{ error: string }>(pending);
  return parsed.error;
}

/** A handle no other suite holds. */
function handle(tag: string): string {
  return `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}${tag}`;
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8")) as Record<string, unknown>;
}

/** Verify a token the way a resource does: with the published JWKS and nothing else. */
async function verifyWithJwks(token: string) {
  const { keys } = await body<{ keys: { kid: string; x: string; crv: string; kty: string }[] }>(
    route(wellKnownJwks, new Request("http://localhost/.well-known/jwks.json")),
  );
  const [header, payload, signature] = token.split(".");
  const head = decode(header);
  const jwk = keys.find((k) => k.kid === head.kid);
  if (!jwk) {
    return { head, payload: decode(payload), valid: false };
  }
  const publicKey = createPublicKey({
    format: "jwk",
    key: { crv: jwk.crv, kty: jwk.kty, x: jwk.x },
  });
  const valid = verify(
    null,
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
  return { head, payload: decode(payload), valid };
}

describe("access gate: names", () => {
  it("accepts handles people can type, and nothing that could pass for the service", () => {
    for (const ok of ["colin", "shae", "a1", "dev-team", "x".repeat(32)]) {
      expect(handleProblem(ok)).toBeNull();
    }
    for (const bad of ["c", "Colin", "1colin", "colin-", "co_lin", "co lin", "x".repeat(33), ""]) {
      expect(handleProblem(bad)).toMatch(/2 to 32/);
    }
    expect(handleProblem("co--lin")).toMatch(/double hyphen/);
    expect(handleProblem("admin")).toMatch(/reserved/);
    expect(handleProblem("share")).toMatch(/reserved/);
  });

  it("names a resource by one canonical URL", () => {
    expect(canonicalResource("https://share.stair-ai.com/")).toBe("https://share.stair-ai.com");
    expect(canonicalResource("https://Share.Stair-AI.com")).toBe("https://share.stair-ai.com");
    expect(canonicalResource("https://data.stair-ai.com/v1/")).toBe("https://data.stair-ai.com/v1");
    expect(canonicalResource("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(canonicalResource("http://share.stair-ai.com")).toBeNull();
    expect(canonicalResource("https://share.stair-ai.com/?x=1")).toBeNull();
    expect(canonicalResource("https://user:pw@share.stair-ai.com")).toBeNull();
    expect(canonicalResource("share.stair-ai.com")).toBeNull();
  });
});

describe("access gate: off", () => {
  it("answers 404 everywhere while no signing key is set", async () => {
    const saved = process.env.RL_ACCESS_SIGNING_KEY;
    delete process.env.RL_ACCESS_SIGNING_KEY;
    try {
      expect(accessConfig()).toBeNull();
      const answers = await Promise.all([
        exchange("sl_whatever"),
        route(wellKnownJwks, new Request("http://localhost/x")),
        route(wellKnownMetadata, new Request("http://localhost/x")),
        route(accessMe, new Request("http://localhost/x")),
      ]);
      expect(answers.map((answer) => answer.status)).toStrictEqual([404, 404, 404, 404]);
    } finally {
      if (saved !== undefined) {
        process.env.RL_ACCESS_SIGNING_KEY = saved;
      }
    }
  });

  it("refuses a signing key without an issuer", () => {
    process.env.RL_ACCESS_SIGNING_KEY = newKey();
    delete process.env.RL_ACCESS_ISSUER;
    expect(() => accessConfig()).toThrow(/RL_ACCESS_ISSUER/);
    delete process.env.RL_ACCESS_SIGNING_KEY;
  });
});

describe("access gate: on", () => {
  let owner: TestOwner;
  let other: TestOwner;
  let bare: TestOwner;
  const key = newKey();
  const previous = newKey();
  let ownerHandle: string;

  beforeAll(async () => {
    process.env.RL_ACCESS_SIGNING_KEY = key;
    process.env.RL_ACCESS_ISSUER = `${ISSUER}/`;
    owner = await makeTestOwner();
    other = await makeTestOwner();
    bare = await makeTestOwner();
    ownerHandle = handle("a");
    await call(
      setOwnerHandle,
      { handle: ownerHandle, owner_id: owner.ownerId, replace: false },
      adminCtx(),
    );
  });

  afterEach(() => {
    process.env.RL_ACCESS_SIGNING_KEY = key;
    process.env.RL_ACCESS_ISSUER = `${ISSUER}/`;
    delete process.env.RL_ACCESS_SIGNING_KEY_PREVIOUS;
    delete process.env.RL_ACCESS_TOKEN_TTL;
  });

  afterAll(async () => {
    delete process.env.RL_ACCESS_SIGNING_KEY;
    delete process.env.RL_ACCESS_ISSUER;
    await owner.cleanup();
    await other.cleanup();
    await bare.cleanup();
  });

  it("publishes its keys and metadata", async () => {
    process.env.RL_ACCESS_SIGNING_KEY_PREVIOUS = previous;
    const { keys } = await body<{ keys: { kid: string; alg: string; crv: string; use: string }[] }>(
      route(wellKnownJwks, new Request("http://localhost/x")),
    );
    expect(keys.map((k) => k.kid)).toStrictEqual([thumbprint(key), thumbprint(previous)]);
    expect(
      keys.every((k) => k.alg === "EdDSA" && k.crv === "Ed25519" && k.use === "sig"),
    ).toBeTruthy();
    const meta = await body(route(wellKnownMetadata, new Request("http://localhost/x")));
    expect(meta).toMatchObject({
      grant_types_supported: [TOKEN_EXCHANGE],
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      token_endpoint: `${ISSUER}/access/token`,
    });
  });

  it("sets handles: once, idempotently, and changes them only on purpose", async () => {
    const view = await call(
      setOwnerHandle,
      { handle: ownerHandle, owner_id: owner.ownerId, replace: false },
      adminCtx(),
    );
    expect(view.handle).toBe(ownerHandle);
    await expect(
      call(
        setOwnerHandle,
        { handle: handle("b"), owner_id: owner.ownerId, replace: false },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      call(
        setOwnerHandle,
        { handle: ownerHandle, owner_id: other.ownerId, replace: false },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      call(
        setOwnerHandle,
        { handle: "Admin", owner_id: other.ownerId, replace: false },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        setOwnerHandle,
        { handle: handle("c"), owner_id: crypto.randomUUID(), replace: false },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const otherHandle = handle("d");
    await call(
      setOwnerHandle,
      { handle: otherHandle, owner_id: other.ownerId, replace: false },
      adminCtx(),
    );
    const renamed = await call(
      setOwnerHandle,
      { handle: handle("e"), owner_id: other.ownerId, replace: true },
      adminCtx(),
    );
    expect(renamed.handle).not.toBe(otherHandle);
    const cleared = await call(
      setOwnerHandle,
      { handle: null, owner_id: other.ownerId, replace: true },
      adminCtx(),
    );
    expect(cleared.handle).toBeNull();
  });

  it("finds an owner by exactly one of id, e-mail and handle", async () => {
    const byHandle = await call(lookupOwner, { handle: ownerHandle }, adminCtx());
    expect(byHandle.owner_id).toBe(owner.ownerId);
    const byId = await call(lookupOwner, { owner_id: owner.ownerId }, adminCtx());
    expect(byId.handle).toBe(ownerHandle);
    await expect(
      call(lookupOwner, { handle: ownerHandle, owner_id: owner.ownerId }, adminCtx()),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(call(lookupOwner, { handle: handle("zz") }, adminCtx())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses an owner without a grant, and grants replace each other", async () => {
    const before = await exchange(owner.apiKey);
    expect(before.status).toBe(400);
    await expect(before.json()).resolves.toMatchObject({ error: "invalid_target" });

    await expect(
      call(
        createAccessGrant,
        { owner_id: owner.ownerId, resource: SHARE, scopes: ["Share:Write"] },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        createAccessGrant,
        { owner_id: owner.ownerId, resource: "http://share.example.test", scopes: ["share:write"] },
        adminCtx(),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const first = await call(
      createAccessGrant,
      { owner_id: owner.ownerId, resource: `${SHARE}/`, scopes: ["share:read"] },
      adminCtx(),
    );
    expect(first.resource).toBe(SHARE);
    const second = await call(
      createAccessGrant,
      {
        note: "the team page",
        owner_id: owner.ownerId,
        resource: SHARE,
        scopes: ["share:write", "share:read", "share:write"],
      },
      adminCtx(),
    );
    expect(second.scopes).toStrictEqual(["share:write", "share:read"]);
    const live = await call(
      listAccessGrants,
      { owner_id: owner.ownerId, state: "live" },
      adminCtx(),
    );
    expect(live.grants.map((g) => g.grant_id)).toStrictEqual([second.grant_id]);
    const all = await call(listAccessGrants, { owner_id: owner.ownerId, state: "all" }, adminCtx());
    expect(all.grants.map((g) => g.grant_id).toSorted()).toStrictEqual(
      [first.grant_id, second.grant_id].toSorted(),
    );
    expect(all.grants.find((g) => g.grant_id === first.grant_id)?.revoked_at).not.toBeNull();
  });

  it("exchanges a key for a token a resource can verify with the JWKS alone", async () => {
    process.env.RL_ACCESS_TOKEN_TTL = "600";
    const response = await exchange(owner.apiKey);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const issuedBody = await body(response);
    expect(issuedBody).toMatchObject({
      expires_in: 600,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "share:write share:read",
      token_type: "Bearer",
    });
    const { head, payload, valid } = await verifyWithJwks(issuedBody.access_token as string);
    expect(valid).toBeTruthy();
    expect(head).toStrictEqual({ alg: "EdDSA", kid: thumbprint(key), typ: "at+jwt" });
    expect(payload).toMatchObject({
      aud: SHARE,
      client_id: "stair",
      handle: ownerHandle,
      iss: ISSUER,
      scope: "share:write share:read",
      sub: owner.ownerId,
    });
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);

    const narrowed = await body<{ scope: string }>(exchange(owner.apiKey, { scope: "share:read" }));
    expect(narrowed.scope).toBe("share:read");
    const viaAudience = await tokenRequest({
      audience: `${SHARE}/`,
      grant_type: TOKEN_EXCHANGE,
      subject_token: owner.apiKey,
      subject_token_type: API_KEY_TOKEN_TYPE,
    });
    expect(viaAudience.status).toBe(200);
  });

  it("leaves the handle out of the token of an owner that has none", async () => {
    await call(
      createAccessGrant,
      { owner_id: bare.ownerId, resource: SHARE, scopes: ["share:write"] },
      adminCtx(),
    );
    const issued = await body<{ access_token: string }>(exchange(bare.apiKey));
    const { payload, valid } = await verifyWithJwks(issued.access_token);
    expect(valid).toBeTruthy();
    expect(payload).not.toHaveProperty("handle");
  });

  it("answers each malformed request with the OAuth error it deserves", async () => {
    const cases: [Promise<Response>, string][] = [
      [exchange(owner.apiKey, { grant_type: "client_credentials" }), "unsupported_grant_type"],
      [exchange("", {}), "invalid_request"],
      [exchange(owner.apiKey, { subject_token_type: "urn:x" }), "invalid_request"],
      [
        exchange(owner.apiKey, {
          requested_token_type: "urn:ietf:params:oauth:token-type:id_token",
        }),
        "invalid_request",
      ],
      [exchange("sl_not-a-key"), "invalid_request"],
      [
        exchange(owner.apiKey, { resource: [SHARE, "https://other.example.test"] }),
        "invalid_target",
      ],
      [exchange(owner.apiKey, { resource: "http://share.example.test" }), "invalid_target"],
      [exchange(owner.apiKey, { resource: "https://other.example.test" }), "invalid_target"],
      [exchange(owner.apiKey, { scope: "share:admin" }), "invalid_scope"],
      [exchange(owner.apiKey, { scope: " " }), "invalid_scope"],
    ];
    for (const [pending, error] of cases) {
      const response = await pending;
      expect(response.status).toBe(400);
      await expect(errorOf(Promise.resolve(response))).resolves.toBe(error);
    }
    const json = await route(
      accessToken,
      new Request("http://localhost/access/token", {
        body: JSON.stringify({ grant_type: TOKEN_EXCHANGE }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(json.status).toBe(400);
  });

  it("stops issuing as soon as the grant is revoked", async () => {
    const { grants } = await call(
      listAccessGrants,
      { owner_id: owner.ownerId, state: "live" },
      adminCtx(),
    );
    const revoked = await call(revokeAccessGrant, { grant_id: grants[0].grant_id }, adminCtx());
    expect(revoked.revoked_at).not.toBeNull();
    const again = await call(revokeAccessGrant, { grant_id: grants[0].grant_id }, adminCtx());
    expect(again.revoked_at).toBe(revoked.revoked_at);
    await expect(errorOf(exchange(owner.apiKey))).resolves.toBe("invalid_target");
    await expect(
      call(revokeAccessGrant, { grant_id: crypto.randomUUID() }, adminCtx()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("tells an owner its handle and grants at /access/me", async () => {
    const me = await body<{
      owner_id: string;
      grants: { resource: string }[];
      handle: string | null;
    }>(
      route(
        accessMe,
        new Request("http://localhost/access/me", { headers: { "x-api-key": bare.apiKey } }),
      ),
    );
    expect(me.owner_id).toBe(bare.ownerId);
    expect(me.handle).toBeNull();
    expect(me.grants.map((g) => g.resource)).toStrictEqual([SHARE]);
    const anonymous = await route(accessMe, new Request("http://localhost/access/me"));
    expect(anonymous.status).toBe(401);
    const wrong = await route(
      accessMe,
      new Request("http://localhost/access/me", { headers: { "x-api-key": "sl_nope" } }),
    );
    expect(wrong.status).toBe(401);
  });

  it("keeps the grants of a deleted owner from lingering", async () => {
    const temp = await makeTestOwner();
    await call(
      createAccessGrant,
      { owner_id: temp.ownerId, resource: SHARE, scopes: ["share:write"] },
      adminCtx(),
    );
    await temp.cleanup();
    await expect(prisma.accessGrant.count({ where: { owner_id: temp.ownerId } })).resolves.toBe(0);
  });
});
