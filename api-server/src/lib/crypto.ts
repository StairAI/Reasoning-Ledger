import { randomBytes, createHash } from "node:crypto";

/**
 * Generate a new API key: `sl_` prefix + 64 random hex chars (32 random bytes).
 * The raw key is shown once at registration and never stored.
 */
export function generateApiKey(): string {
  return `sl_${randomBytes(32).toString("hex")}`;
}

/**
 * SHA-256 hex digest of a raw API key.
 * This is what gets stored in the database.
 */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Compare a raw candidate key against a stored hash in constant time.
 * Uses digest comparison rather than string equality to avoid timing attacks.
 */
export function verifyApiKey(rawKey: string, storedHash: string): boolean {
  const candidateHash = hashApiKey(rawKey);
  // Both are hex strings of the same length — safe to compare directly.
  // Node's crypto doesn't expose timingSafeEqual for strings, so convert to Buffers.
  const a = Buffer.from(candidateHash, "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    // oxlint-disable-next-line no-bitwise
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
