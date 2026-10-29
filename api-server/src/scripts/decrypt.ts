/**
 * Browser-side decryption for the trace viewer.
 *
 * The server renders encrypted content as placeholders (lib/trace.ts
 * ENCRYPTED_TOKEN) and embeds, as JSON, the ciphertext of each encrypted
 * object with the wrapped data key that opens it (lib/content-view.ts). The
 * master key arrives in the sign-in link's fragment (`#k=`, base64url), which
 * the browser never sends; the ticket page keeps it in sessionStorage for the
 * tab. Here: unwrap each data key with the master key, decrypt each object,
 * and put the plaintext where its placeholder is.
 *
 * Formats, shared with the SDKs: AES-256-GCM; a wrapped key or an object is
 * nonce (12 bytes) + ciphertext + tag (16 bytes), with the key id as
 * associated data. master_key_id is the first 16 hex characters of
 * SHA-256(master key).
 */

import { ENCRYPTED_TOKEN } from "#/lib/trace";

export const MASTER_KEY_STORAGE = "rl_mk";

interface EncryptedObject {
  alg: string;
  bytes: number;
  ciphertext: string;
  key_id: string;
  media_type: string;
}

interface WrappedKey {
  master_key_id: string;
  wrap_alg: string;
  wrapped_key: string;
}

export interface PageEncryption {
  keys: Record<string, WrappedKey>;
  objects: Record<string, EncryptedObject>;
}

const NONCE_BYTES = 12;

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The first 16 hex characters of SHA-256(key): how a wrapped key names its master key. */
export async function masterKeyId(masterKey: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", masterKey as BufferSource)).slice(0, 16);
}

/** Open nonce + ciphertext + tag with AES-256-GCM under `key`, with `aad` as associated data. */
export async function open(key: Uint8Array, blob: Uint8Array, aad: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = await crypto.subtle.decrypt(
    {
      additionalData: new TextEncoder().encode(aad),
      iv: blob.slice(0, NONCE_BYTES),
      name: "AES-GCM",
    },
    cryptoKey,
    blob.slice(NONCE_BYTES),
  );
  return new Uint8Array(plain);
}

function isJson(mediaType: string): boolean {
  const type = mediaType.split(";")[0].trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/** Plaintext as the page shows it: text, with JSON laid out. */
export function render(plain: Uint8Array, mediaType: string): string {
  const text = new TextDecoder().decode(plain);
  if (isJson(mediaType)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not valid JSON after all: show it as text.
    }
  }
  return text;
}

/** Decrypt every object of a page with the master key; a failure becomes a note in its place. */
export async function decryptObjects(
  masterKey: Uint8Array,
  page: PageEncryption,
): Promise<Record<string, string>> {
  const keyId = await masterKeyId(masterKey);
  const dataKeys = new Map<string, Uint8Array>();
  const texts: Record<string, string> = {};
  for (const [sha256, object] of Object.entries(page.objects)) {
    const wrapped = page.keys[object.key_id];
    if (!wrapped) {
      texts[sha256] = "[encrypted: its key was never registered]";
      continue;
    }
    if (wrapped.master_key_id !== keyId) {
      texts[sha256] = "[encrypted with another master key]";
      continue;
    }
    try {
      let dataKey = dataKeys.get(object.key_id);
      if (!dataKey) {
        dataKey = await open(masterKey, fromBase64(wrapped.wrapped_key), object.key_id);
        dataKeys.set(object.key_id, dataKey);
      }
      const plain = await open(dataKey, fromBase64(object.ciphertext), object.key_id);
      texts[sha256] = render(plain, object.media_type);
    } catch {
      texts[sha256] = "[encrypted: could not be decrypted]";
    }
  }
  return texts;
}

/** Put the plaintext wherever the page shows a placeholder for it. */
export function replacePlaceholders(root: Node, texts: Record<string, string>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  for (const node of nodes) {
    if (node.data.includes("[encrypted:")) {
      node.data = node.data.replace(
        ENCRYPTED_TOKEN,
        (match, sha256: string) => texts[sha256] ?? match,
      );
    }
  }
}

function storedMasterKey(): Uint8Array | null {
  try {
    const value = sessionStorage.getItem(MASTER_KEY_STORAGE);
    return value ? fromBase64(value) : null;
  } catch {
    return null;
  }
}

/**
 * Decrypt the page: reads #rl-enc, the master key from sessionStorage, and
 * fills the placeholders. Without a key, the banner says how to get one.
 */
export async function decryptPage(): Promise<void> {
  const embedded = document.querySelector("#rl-enc");
  if (!embedded?.textContent) {
    return;
  }
  const page = JSON.parse(embedded.textContent) as PageEncryption;
  if (Object.keys(page.objects).length === 0) {
    return;
  }
  const banner = document.querySelector("#rl-enc-banner");
  const masterKey = storedMasterKey();
  if (!masterKey) {
    banner?.removeAttribute("hidden");
    return;
  }
  const texts = await decryptObjects(masterKey, page);
  replacePlaceholders(document.body, texts);
  banner?.setAttribute("hidden", "");
}
