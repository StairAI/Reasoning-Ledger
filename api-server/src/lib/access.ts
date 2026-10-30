/**
 * The access gate (2.2.0; design: Agent Access v0.3).
 *
 * An owner's API key is the account's master credential, and it is only ever
 * sent here. A resource other than the ledger (the first is
 * share.stair-ai.com) never sees it: the owner exchanges the key at
 * POST /access/token for a short-lived access token bound to that one resource
 * (RFC 8693 token exchange with an RFC 8707 resource indicator), and the
 * resource checks the token offline against the keys this server publishes at
 * /.well-known/jwks.json.
 *
 * Who may get a token for what is decided here, by grants the administrator
 * makes; a resource reads only the scopes in the token. Every resource uses
 * the owner's handle, also set by the administrator, as that owner's
 * namespace.
 *
 * Configuration. Without a signing key the gate is off and its endpoints
 * answer 404; the ledger itself works as before either way.
 *
 *   RL_ACCESS_SIGNING_KEY           Ed25519 private key, base64 PKCS#8 DER (`pnpm access-key` makes one)
 *   RL_ACCESS_SIGNING_KEY_PREVIOUS  the key before the last rotation: its public half stays in the JWKS
 *                                   so that tokens it signed keep verifying until they expire
 *   RL_ACCESS_ISSUER                the gate's own URL, `iss` of every token (https://access.stair-ai.com)
 *   RL_ACCESS_TOKEN_TTL             token lifetime in seconds (default 3600, 60 to 86400)
 */

import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { ORPCError } from "@orpc/server";
import * as z from "zod";
import { ownerForApiKey } from "#/lib/auth";
import { prisma } from "#/lib/prisma";

// ---------------------------------------------------------------------------
// Configuration and keys
// ---------------------------------------------------------------------------

export interface PublicJwk {
  alg: "EdDSA";
  crv: "Ed25519";
  kid: string;
  kty: "OKP";
  use: "sig";
  x: string;
}

interface SigningKey {
  jwk: PublicJwk;
  privateKey: KeyObject;
}

export interface AccessConfig {
  issuer: string;
  current: SigningKey;
  previous: SigningKey | null;
  ttl: number;
}

const DEFAULT_TTL = 3600;

function loadKey(value: string, name: string): SigningKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({
      format: "der",
      key: Buffer.from(value.trim(), "base64"),
      type: "pkcs8",
    });
  } catch {
    throw new Error(`${name} is not a base64 PKCS#8 private key`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${name} must be an Ed25519 key`);
  }
  const { crv, kty, x } = createPublicKey(privateKey).export({ format: "jwk" }) as {
    crv: string;
    kty: string;
    x: string;
  };
  // RFC 7638 thumbprint: the required members, in lexicographic order, no whitespace.
  const kid = createHash("sha256").update(JSON.stringify({ crv, kty, x })).digest("base64url");
  return { jwk: { alg: "EdDSA", crv: "Ed25519", kid, kty: "OKP", use: "sig", x }, privateKey };
}

let cached: { env: string; config: AccessConfig | null } | undefined;

/** The gate's configuration, or null when no signing key is set (the gate is off). */
export function accessConfig(): AccessConfig | null {
  const {
    RL_ACCESS_ISSUER: issuerEnv,
    RL_ACCESS_SIGNING_KEY: keyEnv,
    RL_ACCESS_SIGNING_KEY_PREVIOUS: previousEnv,
    RL_ACCESS_TOKEN_TTL: ttlEnv,
  } = process.env;
  const env = [issuerEnv, keyEnv, previousEnv, ttlEnv].join("\n");
  if (cached?.env === env) {
    return cached.config;
  }
  let config: AccessConfig | null = null;
  if (keyEnv) {
    const issuer = issuerEnv ? canonicalUrl(issuerEnv) : null;
    if (!issuer) {
      throw new Error(
        "RL_ACCESS_ISSUER must be the gate's absolute URL when RL_ACCESS_SIGNING_KEY is set",
      );
    }
    const ttl = ttlEnv ? Number(ttlEnv) : DEFAULT_TTL;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86_400) {
      throw new Error("RL_ACCESS_TOKEN_TTL must be a whole number of seconds from 60 to 86400");
    }
    config = {
      current: loadKey(keyEnv, "RL_ACCESS_SIGNING_KEY"),
      issuer,
      previous: previousEnv ? loadKey(previousEnv, "RL_ACCESS_SIGNING_KEY_PREVIOUS") : null,
      ttl,
    };
  }
  cached = { config, env };
  return config;
}

/** The public keys a resource verifies tokens with (RFC 7517). */
export function jwks(config: AccessConfig): { keys: PublicJwk[] } {
  return { keys: [config.current.jwk, ...(config.previous ? [config.previous.jwk] : [])] };
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(config: AccessConfig) {
  return {
    grant_types_supported: [TOKEN_EXCHANGE],
    issuer: config.issuer,
    jwks_uri: `${config.issuer}/.well-known/jwks.json`,
    token_endpoint: `${config.issuer}/access/token`,
    token_endpoint_auth_methods_supported: ["none"],
  };
}

// ---------------------------------------------------------------------------
// Names: handles, resources, scopes
// ---------------------------------------------------------------------------

/** 2 to 32 characters: lowercase letters, digits, hyphens; starts with a letter, ends with a letter or digit. */
export const HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

/** Names a person could mistake for the service itself. */
const RESERVED_HANDLES = new Set([
  "access",
  "account",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "help",
  "login",
  "logout",
  "me",
  "null",
  "official",
  "root",
  "security",
  "settings",
  "share",
  "stair",
  "stair-ai",
  "stairai",
  "static",
  "status",
  "support",
  "system",
  "undefined",
  "well-known",
  "www",
]);

/** Why a handle cannot be used, or null when it can. */
export function handleProblem(handle: string): string | null {
  if (!HANDLE_PATTERN.test(handle)) {
    return "A handle is 2 to 32 lowercase letters, digits or hyphens, starts with a letter and ends with a letter or digit";
  }
  if (handle.includes("--")) {
    return "A handle has no double hyphen";
  }
  if (RESERVED_HANDLES.has(handle)) {
    return `"${handle}" is reserved`;
  }
  return null;
}

/** A scope names its resource's vocabulary and an action, as in share:write. */
export const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** An absolute https URL (http only on this machine), without credentials, query, fragment or trailing slash. */
function canonicalUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLocalHost(url.hostname));
  if (!secure || url.username || url.password || url.search || url.hash) {
    return null;
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** A resource as grants and tokens name it: its canonical URL, which is the audience of its tokens. */
export function canonicalResource(raw: string): string | null {
  return canonicalUrl(raw);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const GrantView = z.object({
  created_at: z.number(),
  grant_id: z.string(),
  note: z.string().nullable(),
  owner_id: z.string(),
  resource: z.string(),
  revoked_at: z.number().nullable(),
  scopes: z.array(z.string()),
});
export type GrantView = z.infer<typeof GrantView>;

interface GrantRow {
  id: string;
  owner_id: string;
  resource: string;
  scopes: string[];
  note: string | null;
  created_at: Date;
  revoked_at: Date | null;
}

export function grantView(row: GrantRow): GrantView {
  return {
    created_at: row.created_at.getTime(),
    grant_id: row.id,
    note: row.note,
    owner_id: row.owner_id,
    resource: row.resource,
    revoked_at: row.revoked_at?.getTime() ?? null,
    scopes: row.scopes,
  };
}

export const OwnerAccessView = z.object({
  email: z.string().nullable(),
  grants: z.array(GrantView),
  handle: z.string().nullable(),
  owner_id: z.string(),
});
export type OwnerAccessView = z.infer<typeof OwnerAccessView>;

/** An owner as the gate sees it: handle and live grants. */
export async function ownerAccessView(ownerId: string): Promise<OwnerAccessView> {
  const owner = await prisma.owner.findUnique({
    select: { email: true, handle: true, id: true },
    where: { id: ownerId },
  });
  if (!owner) {
    throw new ORPCError("NOT_FOUND", { message: "Owner not found" });
  }
  const grants = await prisma.accessGrant.findMany({
    orderBy: { created_at: "asc" },
    where: { owner_id: ownerId, revoked_at: null },
  });
  return {
    email: owner.email,
    grants: grants.map(grantView),
    handle: owner.handle,
    owner_id: owner.id,
  };
}

// ---------------------------------------------------------------------------
// Administration: handles and grants
// ---------------------------------------------------------------------------

/**
 * Give an owner a handle, change it, or clear it (null). Links that resources
 * made under a handle stop working when it changes, so changing or clearing an
 * existing one needs `replace`.
 */
export async function setHandle(
  ownerId: string,
  handle: string | null,
  replace: boolean,
): Promise<OwnerAccessView> {
  const owner = await prisma.owner.findUnique({
    select: { handle: true },
    where: { id: ownerId },
  });
  if (!owner) {
    throw new ORPCError("NOT_FOUND", { message: "Owner not found" });
  }
  if (handle !== null) {
    const problem = handleProblem(handle);
    if (problem) {
      throw new ORPCError("BAD_REQUEST", { message: problem });
    }
  }
  if (owner.handle === handle) {
    return ownerAccessView(ownerId);
  }
  if (owner.handle && !replace) {
    throw new ORPCError("CONFLICT", {
      message: `This owner's handle is already "${owner.handle}", and links under it stop working if it changes; pass replace: true to change it`,
    });
  }
  if (handle !== null) {
    const holder = await prisma.owner.findUnique({ select: { id: true }, where: { handle } });
    if (holder && holder.id !== ownerId) {
      throw new ORPCError("CONFLICT", {
        message: `The handle "${handle}" belongs to another owner`,
      });
    }
  }
  try {
    await prisma.owner.update({ data: { handle }, where: { id: ownerId } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      throw new ORPCError("CONFLICT", {
        message: `The handle "${handle}" belongs to another owner`,
      });
    }
    throw error;
  }
  return ownerAccessView(ownerId);
}

function checkedResource(raw: string): string {
  const resource = canonicalResource(raw);
  if (!resource) {
    throw new ORPCError("BAD_REQUEST", {
      message:
        "A resource is an absolute https URL without query or fragment, such as https://share.stair-ai.com",
    });
  }
  return resource;
}

/** Let an owner get tokens for a resource; replaces the owner's live grant for that resource, if any. */
export async function createGrant(input: {
  owner_id: string;
  resource: string;
  scopes: string[];
  note?: string;
}): Promise<GrantView> {
  const resource = checkedResource(input.resource);
  const scopes = [...new Set(input.scopes)];
  const bad = scopes.filter((scope) => !SCOPE_PATTERN.test(scope));
  if (bad.length > 0) {
    throw new ORPCError("BAD_REQUEST", {
      message: `A scope reads <vocabulary>:<action>, as in share:write; not: ${bad.join(" ")}`,
    });
  }
  const owner = await prisma.owner.findUnique({
    select: { id: true },
    where: { id: input.owner_id },
  });
  if (!owner) {
    throw new ORPCError("NOT_FOUND", { message: "Owner not found" });
  }
  const row = await prisma.$transaction(async (tx) => {
    await tx.accessGrant.updateMany({
      data: { revoked_at: new Date() },
      where: { owner_id: input.owner_id, resource, revoked_at: null },
    });
    return tx.accessGrant.create({
      data: { note: input.note ?? null, owner_id: input.owner_id, resource, scopes },
    });
  });
  return grantView(row);
}

export async function listGrants(filter: {
  owner_id?: string;
  resource?: string;
  state: "live" | "all";
}): Promise<GrantView[]> {
  const resource = filter.resource ? checkedResource(filter.resource) : undefined;
  const rows = await prisma.accessGrant.findMany({
    orderBy: { created_at: "desc" },
    take: 1000,
    where: {
      ...(filter.owner_id && { owner_id: filter.owner_id }),
      ...(resource && { resource }),
      ...(filter.state === "live" && { revoked_at: null }),
    },
  });
  return rows.map(grantView);
}

/** Stop a grant: no new tokens. Tokens already issued stay valid until they expire (at most the TTL). */
export async function revokeGrant(grantId: string): Promise<GrantView> {
  const row = await prisma.accessGrant.findUnique({ where: { id: grantId } });
  if (!row) {
    throw new ORPCError("NOT_FOUND", { message: "Grant not found" });
  }
  if (row.revoked_at) {
    return grantView(row);
  }
  return grantView(
    await prisma.accessGrant.update({ data: { revoked_at: new Date() }, where: { id: grantId } }),
  );
}

// ---------------------------------------------------------------------------
// Token exchange (POST /access/token)
// ---------------------------------------------------------------------------

export const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
/** The subject token type for an owner's API key, the credential exchanged in this round. */
export const API_KEY_TOKEN_TYPE = "urn:stair:params:oauth:token-type:api-key";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/** The client every token names (RFC 9068 `client_id`): agents are public clients of the gate. */
export const CLIENT_ID = "stair";

export interface TokenResult {
  status: number;
  body: Record<string, unknown>;
}

function oauthError(error: string, description: string, status = 400): TokenResult {
  return { body: { error, error_description: description }, status };
}

function encodePart(part: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(part)).toString("base64url");
}

function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${encodePart(header)}.${encodePart(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

/**
 * Exchange an owner's API key for an access token to one resource the owner
 * holds a live grant for. Errors follow RFC 6749 §5.2 and RFC 8693 §2.2.2.
 */
export async function exchangeToken(
  params: URLSearchParams,
  config: AccessConfig,
  now = Date.now(),
): Promise<TokenResult> {
  if (params.get("grant_type") !== TOKEN_EXCHANGE) {
    return oauthError("unsupported_grant_type", `grant_type must be ${TOKEN_EXCHANGE}`);
  }
  const subjectToken = params.get("subject_token");
  if (!subjectToken) {
    return oauthError("invalid_request", "subject_token is required: the owner's API key");
  }
  if (params.get("subject_token_type") !== API_KEY_TOKEN_TYPE) {
    return oauthError("invalid_request", `subject_token_type must be ${API_KEY_TOKEN_TYPE}`);
  }
  const requested = params.get("requested_token_type");
  if (requested && requested !== ACCESS_TOKEN_TYPE) {
    return oauthError("invalid_request", `requested_token_type can only be ${ACCESS_TOKEN_TYPE}`);
  }
  const targets =
    params.getAll("resource").length > 0 ? params.getAll("resource") : params.getAll("audience");
  if (targets.length !== 1) {
    return oauthError("invalid_target", "Name exactly one resource");
  }
  const resource = canonicalResource(targets[0]);
  if (!resource) {
    return oauthError(
      "invalid_target",
      "The resource must be an absolute https URL without query or fragment",
    );
  }
  const owner = await ownerForApiKey(subjectToken);
  if (!owner) {
    return oauthError("invalid_request", "subject_token is not a valid API key");
  }
  const grant = await prisma.accessGrant.findFirst({
    orderBy: { created_at: "desc" },
    where: { owner_id: owner.ownerId, resource, revoked_at: null },
  });
  if (!grant) {
    return oauthError("invalid_target", `This account has no access to ${resource}`);
  }
  let { scopes } = grant;
  const asked = params.get("scope");
  if (asked !== null) {
    const wanted = [...new Set(asked.split(" ").filter(Boolean))];
    const missing = wanted.filter((scope) => !grant.scopes.includes(scope));
    if (wanted.length === 0 || missing.length > 0) {
      return oauthError(
        "invalid_scope",
        `Not granted at ${resource}: ${missing.join(" ") || "(empty scope)"}`,
      );
    }
    scopes = wanted;
  }
  const row = await prisma.owner.findUnique({
    select: { handle: true },
    where: { id: owner.ownerId },
  });
  const iat = Math.floor(now / 1000);
  const scope = scopes.join(" ");
  const token = signJwt(
    { alg: "EdDSA", kid: config.current.jwk.kid, typ: "at+jwt" },
    {
      aud: resource,
      client_id: CLIENT_ID,
      exp: iat + config.ttl,
      ...(row?.handle && { handle: row.handle }),
      iat,
      iss: config.issuer,
      jti: randomUUID(),
      scope,
      sub: owner.ownerId,
    },
    config.current.privateKey,
  );
  return {
    body: {
      access_token: token,
      expires_in: config.ttl,
      issued_token_type: ACCESS_TOKEN_TYPE,
      scope,
      token_type: "Bearer",
    },
    status: 200,
  };
}

/** Headers for every answer that carries or concerns a credential (RFC 6749 §5.1). */
export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

/** What every gate endpoint answers while the gate is off. */
export function gateOff(): Response {
  return Response.json(
    { message: "This server does not run the access gate (RL_ACCESS_SIGNING_KEY is not set)" },
    { status: 404 },
  );
}
