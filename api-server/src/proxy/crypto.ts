import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const MASTER_KEY = process.env.PROXY_ENCRYPTION_KEY
  ? Buffer.from(process.env.PROXY_ENCRYPTION_KEY, "base64")
  : null;

if (!MASTER_KEY || MASTER_KEY.length !== 32) {
  console.warn(
    "WARNING: PROXY_ENCRYPTION_KEY not set or invalid (must be 32 bytes base64-encoded). Using insecure fallback for development.",
  );
}

export function encryptUpstreamKey(plaintext: string): string {
  if (!MASTER_KEY) {
    // Dev fallback: just base64 (NOT SECURE)
    return Buffer.from(plaintext).toString("base64");
  }

  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, MASTER_KEY, iv);

  let encrypted = cipher.update(plaintext, "utf-8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptUpstreamKey(ciphertext: string): string {
  if (!MASTER_KEY) {
    // Dev fallback
    return Buffer.from(ciphertext, "base64").toString("utf-8");
  }

  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Invalid ciphertext format");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf-8");
  decrypted += decipher.final("utf-8");

  return decrypted;
}
