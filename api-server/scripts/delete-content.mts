/**
 * Delete stored content (design §3). An operator command, deliberately not an
 * HTTP endpoint.
 *
 *   pnpm --dir api-server delete-content --owner <owner_id> --sha256 <hex> \
 *     --reason "<why>" --operator "<who>"
 *
 * Marks the object deleted, writes an entry to content_deletions and removes
 * its database copy, in one transaction; then removes the bytes from the file
 * store and, when an object store is configured, from the bucket. Every place
 * is cleared, not only the one the row names: a file stays behind for a while
 * after an object is moved (scripts/content.mts), and a bucket may hold a copy
 * of an object moved back. Records that reference the content are not touched:
 * the hash in them still shows the content existed, and reading the content
 * afterwards answers 410.
 *
 * The server's bucket credential should not be allowed to delete objects. With
 * that credential the command marks the content deleted, says which object is
 * left in the bucket and exits with status 3; delete it with a credential that
 * may (the bucket's versioning keeps the bytes for its retention period).
 *
 * Runs as the migration account (MIGRATION_DATABASE_URL, falling back to
 * DATABASE_URL): the runtime account cannot write content_deletions or delete
 * from content_blobs. Needs the same CONTENT_DIR and CONTENT_S3_* settings as
 * the server.
 */

import "./env.mts";
import { parseArgs } from "node:util";
import { Client } from "pg";
import {
  ContentStoreError,
  contentConfig,
  deleteFileObject,
  deleteS3Object,
  s3Key,
  s3ObjectExists,
} from "../src/lib/content-store.ts";

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
let config: ReturnType<typeof contentConfig>;
try {
  config = contentConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
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
  await client.query("DELETE FROM content_blobs WHERE owner_id = $1 AND sha256 = $2", [
    owner,
    sha256,
  ]);
  await client.query("COMMIT");
} finally {
  await client.end();
}

await deleteFileObject(owner, sha256);

if (config.s3) {
  const where = `s3://${config.s3.bucket}/${s3Key(owner, sha256)}`;
  try {
    if (await s3ObjectExists(owner, sha256, config)) {
      await deleteS3Object(owner, sha256, config);
    }
  } catch (error) {
    const why = error instanceof ContentStoreError ? error.message : String(error);
    console.error(
      `marked ${sha256} deleted for owner ${owner}, but its bytes are still in the bucket at ${where}: ${why}. Delete that object with a credential that may.`,
    );
    process.exit(3);
  }
}
console.log(`deleted ${sha256} for owner ${owner}`);
