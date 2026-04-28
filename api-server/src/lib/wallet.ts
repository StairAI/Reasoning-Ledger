import { randomBytes } from "node:crypto";

/**
 * Generate a custodial SUI-format wallet address placeholder.
 *
 * SUI addresses are 32-byte values represented as 0x-prefixed 64 hex chars.
 * In v0.1 these are stored as metadata only — no actual SUI key is generated.
 * The v1 anchoring pipeline will replace this with real KMS-backed addresses.
 */
export function generateWalletAddress(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}
