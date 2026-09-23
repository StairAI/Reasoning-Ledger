/**
 * Delete stored content (design §3). An operator command, deliberately not an
 * HTTP endpoint.
 *
 *   pnpm --dir api-server delete-content --owner <owner_id> --sha256 <hex> \
 *     --reason "<why>" --operator "<who>"
 *
 * Marks the object deleted, writes an entry to content_deletions, then removes
 * the bytes from the content store. Records that reference the content are not
 * touched: the hash in them still shows the content existed, and reading the
 * content afterwards answers 410.
 *
 * Runs as the migration account (MIGRATION_DATABASE_URL, falling back to
 * DATABASE_URL): the runtime account cannot write content_deletions. Needs the
 * same CONTENT_DIR the server uses.
 */

import "./env.mts";
import { rm } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";

const { values } = parseArgs({
  options: {
    operator: { type: "string" },
    owner: { type: "string" },
    reason: { type: "string" },
    sha256: { type: "string" },
  },
});

const { operator, owner, reason, sha256 } = values;
if (!owner || !sha256 || !reason || !operator) {
  console.error(
    'usage: delete-content --owner <owner_id> --sha256 <hex> --reason "<why>" --operator "<who>"',
  );
  process.exit(2);
}
if (!/^[0-9a-f]{64}$/.test(sha256)) {
  console.error("--sha256 must be 64 lowercase hex characters");
  process.exit(2);
}
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATION_DATABASE_URL (or DATABASE_URL)");
  process.exit(2);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  const marked = await client.query(
    `UPDATE content_objects SET deleted_at = now()
     WHERE owner_id = $1 AND sha256 = $2 AND deleted_at IS NULL`,
    [owner, sha256],
  );
  if (marked.rowCount !== 1) {
    await client.query("ROLLBACK");
    console.error(
      `no stored content ${sha256} for owner ${owner} (never uploaded or already deleted)`,
    );
    process.exit(1);
  }
  await client.query(
    `INSERT INTO content_deletions (id, owner_id, sha256, reason, operator)
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4)`,
    [owner, sha256, reason, operator],
  );
  await client.query("COMMIT");
} finally {
  await client.end();
}

const file = path.join(path.resolve(process.env.CONTENT_DIR ?? "data/content"), owner, sha256);
await rm(file, { force: true });
console.log(`deleted ${sha256} for owner ${owner}`);
