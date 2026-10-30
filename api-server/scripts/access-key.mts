/**
 * Make a signing key for the access gate (src/lib/access.ts). An operator
 * command: it prints the key, base64 PKCS#8 DER, on stdout for the
 * deployment's secret store, and the key id it will publish on stderr.
 *
 *   pnpm --dir api-server access-key > access-signing-key   # then into RL_ACCESS_SIGNING_KEY
 *
 * Rotating: move the current value to RL_ACCESS_SIGNING_KEY_PREVIOUS and put
 * a new one in RL_ACCESS_SIGNING_KEY. Tokens the previous key signed keep
 * verifying until they expire (RL_ACCESS_TOKEN_TTL); after that the previous
 * key can go.
 */

import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ed25519");
const { crv, kty, x } = createPublicKey(privateKey).export({ format: "jwk" }) as {
  crv: string;
  kty: string;
  x: string;
};
const kid = createHash("sha256").update(JSON.stringify({ crv, kty, x })).digest("base64url");
process.stderr.write(`access gate signing key, key id ${kid}\n`);
process.stdout.write(`${privateKey.export({ format: "der", type: "pkcs8" }).toString("base64")}\n`);
