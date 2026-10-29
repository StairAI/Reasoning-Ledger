import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeObject } from "#/lib/content-store";
import { prisma } from "#/lib/prisma";
import { registerAgent } from "#/routes/agents";
import { getContentKey, listContentKeys, putContentKey } from "#/routes/content-keys";
import { submitRecord } from "#/routes/records";
import { decryptObjects, masterKeyId, render } from "#/scripts/decrypt";
import { adminCtx, call, ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

/**
 * AES-256-GCM as the SDKs and the browser use it: nonce (12) + ciphertext +
 * tag (16), with the key id as associated data.
 */
function seal(key: Buffer, plain: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function fingerprint(masterKey: Buffer): string {
  return createHash("sha256").update(masterKey).digest("hex").slice(0, 16);
}

function wrappedKeyBody(masterKey: Buffer, dataKey: Buffer, keyId: string, extra = {}) {
  return {
    master_key_id: fingerprint(masterKey),
    wrap_alg: "A256GCM" as const,
    wrapped_key: seal(masterKey, dataKey, keyId).toString("base64"),
    ...extra,
  };
}

describe("content keys", () => {
  let owner: TestOwner;
  let other: TestOwner;
  let agentId: string;
  let contentDir: string;
  const masterKey = randomBytes(32);
  const dataKey = randomBytes(32);
  const keyId = crypto.randomUUID();

  beforeAll(async () => {
    contentDir = mkdtempSync(path.join(tmpdir(), "rl-keys-"));
    process.env.CONTENT_DIR = contentDir;
    [owner, other] = await Promise.all([makeTestOwner(), makeTestOwner()]);
    const agent = await call(registerAgent, { name: "keys-agent" }, ctx(owner.apiKey));
    agentId = agent.agent_id;
  });

  afterAll(async () => {
    await prisma.contentKey.deleteMany({
      where: { owner_id: { in: [owner.ownerId, other.ownerId] } },
    });
    await prisma.contentObject.deleteMany({
      where: { owner_id: { in: [owner.ownerId, other.ownerId] } },
    });
    await Promise.all([owner.cleanup(), other.cleanup()]);
    rmSync(contentDir, { force: true, recursive: true });
  });

  it("registers a wrapped key once, and replaces the wrapped copy on a second PUT", async () => {
    const body = wrappedKeyBody(masterKey, dataKey, keyId, {
      agent_id: agentId,
      session_id: "s-1",
    });
    const first = await call(putContentKey, { key_id: keyId, ...body }, ctx(owner.apiKey));
    expect(first).toMatchObject({
      created: true,
      key_id: keyId,
      owner_id: owner.ownerId,
      session_id: "s-1",
    });

    const rewrapped = wrappedKeyBody(masterKey, dataKey, keyId);
    const second = await call(putContentKey, { key_id: keyId, ...rewrapped }, ctx(owner.apiKey));
    expect(second.created).toBeFalsy();
    expect(second.wrapped_key).toBe(rewrapped.wrapped_key);
  });

  it("refuses a wrapped key of the wrong size, and an agent of another owner", async () => {
    await expect(
      call(
        putContentKey,
        {
          key_id: "short",
          master_key_id: fingerprint(masterKey),
          wrap_alg: "A256GCM",
          wrapped_key: Buffer.alloc(10).toString("base64"),
        },
        ctx(owner.apiKey),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("60 bytes") });
    await expect(
      call(
        putContentKey,
        {
          key_id: "foreign-agent",
          ...wrappedKeyBody(masterKey, dataKey, "foreign-agent", { agent_id: agentId }),
        },
        ctx(other.apiKey),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("agent_id") });
  });

  it("reads back only the owner's keys; the administrator reads any", async () => {
    const mine = await call(getContentKey, { key_id: keyId }, ctx(owner.apiKey));
    expect(mine.master_key_id).toBe(fingerprint(masterKey));
    await expect(call(getContentKey, { key_id: keyId }, ctx(other.apiKey))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const asAdmin = await call(getContentKey, { key_id: keyId }, adminCtx());
    expect(asAdmin.owner_id).toBe(owner.ownerId);

    const page = await call(listContentKeys, { session_id: "nope" }, ctx(owner.apiKey));
    expect(page.keys).toHaveLength(0);
    const all = await call(listContentKeys, undefined, ctx(owner.apiKey));
    expect(all.keys.map((k) => k.key_id)).toContain(keyId);
    expect(all.next_after).toBeNull();
  });

  it("accepts a record whose encrypted content names a registered key, and rejects one that does not", async () => {
    const plain = Buffer.from("the prompt", "utf-8");
    const ciphertext = seal(dataKey, plain, keyId);
    const sha256 = createHash("sha256").update(ciphertext).digest("hex");
    await writeObject(owner.ownerId, sha256, new Blob([ciphertext]).stream());
    await prisma.contentObject.create({
      data: {
        bytes: ciphertext.length,
        media_type: "application/octet-stream",
        owner_id: owner.ownerId,
        sha256,
      },
    });
    const enc = (id: string) => ({
      alg: "A256GCM" as const,
      key_id: id,
      plaintext_bytes: plain.length,
      plaintext_media_type: "text/plain; charset=utf-8",
      plaintext_sha256: createHash("sha256").update(plain).digest("hex"),
    });
    const ref = (id: string) => ({
      bytes: ciphertext.length,
      enc: enc(id),
      media_type: "application/octet-stream",
      sha256,
    });

    await expect(
      call(
        submitRecord,
        makeObservingInput(agentId, { trigger_payload: ref("never-registered") }),
        ctx(owner.apiKey),
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("content key never-registered has not been registered"),
    });

    const ack = await call(
      submitRecord,
      makeObservingInput(agentId, { trigger_payload: ref(keyId) }),
      ctx(owner.apiKey),
    );
    expect(ack.record_id).toBeDefined();

    // What the browser does with the page's ciphertext and wrapped key (scripts/decrypt.ts).
    const wrapped = await call(getContentKey, { key_id: keyId }, ctx(owner.apiKey));
    const texts = await decryptObjects(new Uint8Array(masterKey), {
      keys: {
        [keyId]: {
          master_key_id: wrapped.master_key_id,
          wrap_alg: wrapped.wrap_alg,
          wrapped_key: wrapped.wrapped_key,
        },
      },
      objects: {
        [sha256]: {
          alg: "A256GCM",
          bytes: plain.length,
          ciphertext: ciphertext.toString("base64"),
          key_id: keyId,
          media_type: "text/plain; charset=utf-8",
        },
      },
    });
    expect(texts[sha256]).toBe("the prompt");
    await expect(masterKeyId(new Uint8Array(masterKey))).resolves.toBe(fingerprint(masterKey));

    const wrongKey = await decryptObjects(new Uint8Array(randomBytes(32)), {
      keys: {
        [keyId]: {
          master_key_id: wrapped.master_key_id,
          wrap_alg: wrapped.wrap_alg,
          wrapped_key: wrapped.wrapped_key,
        },
      },
      objects: {
        [sha256]: {
          alg: "A256GCM",
          bytes: plain.length,
          ciphertext: ciphertext.toString("base64"),
          key_id: keyId,
          media_type: "text/plain; charset=utf-8",
        },
      },
    });
    expect(wrongKey[sha256]).toBe("[encrypted with another master key]");
    expect(render(new TextEncoder().encode('{"b":1,"a":[2]}'), "application/json")).toBe(
      '{\n  "b": 1,\n  "a": [\n    2\n  ]\n}',
    );
  });
});
