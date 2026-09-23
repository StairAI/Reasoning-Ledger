/**
 * Bring the database to the current schema, then re-apply the runtime
 * account's privileges (design §5). Runs before the server starts.
 *
 *   pnpm --dir api-server db:deploy
 *
 * Environment (from the process, or from api-server/.env):
 *   MIGRATION_DATABASE_URL  migration account (falls back to DATABASE_URL)
 *   RL_RUNTIME_ROLE         role the server connects as; when set, prisma/grants.sql
 *                           is applied for it after migrating
 *
 * A database created before migrations were used (for example by `prisma db push`)
 * has no migration history and must be baselined once before the first run:
 *   pnpm --dir api-server exec prisma migrate resolve --applied 20260428075327_init_schema
 */

import "./env.mts";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const apiServer = path.resolve(import.meta.dirname, "..");
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set MIGRATION_DATABASE_URL (or DATABASE_URL)");
  process.exit(2);
}

const migrate = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
  cwd: apiServer,
  env: { ...process.env, MIGRATION_DATABASE_URL: url },
  stdio: "inherit",
});
if (migrate.status !== 0) {
  process.exit(migrate.status ?? 1);
}

const role = process.env.RL_RUNTIME_ROLE;
if (role) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const sql = readFileSync(path.join(apiServer, "prisma/grants.sql"), "utf-8").replaceAll(
      "{{runtime}}",
      client.escapeIdentifier(role),
    );
    await client.query(sql);
  } finally {
    await client.end();
  }
  console.log(`runtime privileges applied for ${role}`);
}
