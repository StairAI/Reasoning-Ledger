/**
 * Where content is kept, checked and moved (design §3, lib/content-store.ts).
 * Operator commands: run them with the server's CONTENT_* settings, as the
 * migration account (MIGRATION_DATABASE_URL, falling back to DATABASE_URL).
 *
 *   pnpm --dir api-server content check
 *       The settings are valid and, with an object store configured, the bucket
 *       takes writes and returns them. Needs no database. The image's entrypoint
 *       runs it before the server starts, so a deployment with settings that do
 *       not work fails instead of serving.
 *
 *   pnpm --dir api-server content census [--json]
 *       How many objects and bytes are where; how many the current settings
 *       would move; how many are kept in the database although larger than
 *       CONTENT_INLINE_MAX_BYTES (the object store refused them); and how many
 *       are not encrypted (a media type other than application/octet-stream,
 *       which is what encrypted content is uploaded as).
 *
 *   pnpm --dir api-server content verify [--location fs|db|s3] [--owner <id>] [--concurrency n] [--json]
 *       Read every object that is not deleted from where its row says, and check
 *       it against its hash. Exit status 4 when any is missing, fails its check
 *       or cannot be read.
 *
 *   pnpm --dir api-server content move [--to fs] [--owner <id>] [--limit n] [--concurrency n] [--dry-run] [--json]
 *       Put each object where the current settings place it (CONTENT_STORE and
 *       CONTENT_INLINE_MAX_BYTES), or with --to fs back into files: read it and
 *       check it, write it to the new place, read it back from there and check
 *       it, and only then switch its row. Files are never removed, so moving
 *       back to fs while they are there switches rows without copying; a
 *       database copy is removed once its object is elsewhere; the bucket is
 *       only ever added to. Each object moves on its own while the server keeps
 *       running, so the command can be stopped and run again. Exit status 4
 *       when any object could not be moved.
 */

import "./env.mts";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import {
  CONTENT_LOCATIONS,
  ContentStoreError,
  bufferOf,
  contentConfig,
  fileObjectExists,
  getS3Object,
  isContentLocation,
  placement,
  probeObjectStore,
  putS3Object,
  readFileObject,
  release,
  verifyBlob,
  writeFileObject,
} from "../src/lib/content-store.ts";
import type { ContentConfig, ContentLocation, Held } from "../src/lib/content-store.ts";

const USAGE = `usage: content check
       content census [--json]
       content verify [--location fs|db|s3] [--owner <id>] [--concurrency n] [--json]
       content move [--to fs] [--owner <id>] [--limit n] [--concurrency n] [--dry-run] [--json]`;

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    concurrency: { default: "4", type: "string" },
    "dry-run": { default: false, type: "boolean" },
    json: { default: false, type: "boolean" },
    limit: { type: "string" },
    location: { type: "string" },
    owner: { type: "string" },
    to: { type: "string" },
  },
});

function die(message: string, status = 2): never {
  console.error(message);
  process.exit(status);
}

function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    die(`--${name} must be a positive whole number`);
  }
  return Number(value);
}

let config: ContentConfig;
try {
  config = contentConfig();
} catch (error) {
  die(error instanceof Error ? error.message : String(error), 1);
}

function where(settings: ContentConfig): string {
  const store =
    settings.store === "s3" && settings.s3 ? `the bucket ${settings.s3.bucket}` : "files";
  return settings.inlineMax > 0
    ? `new content of at most ${settings.inlineMax} bytes goes to the database, larger to ${store}`
    : `new content goes to ${store}`;
}

if (command === "check") {
  console.log(`content: ${where(config)}`);
  if (config.s3) {
    try {
      console.log(`content: ${await probeObjectStore(config)}`);
    } catch (error) {
      die(`content: ${error instanceof Error ? error.message : String(error)}`, 1);
    }
  }
  process.exit(0);
}

if (command !== "census" && command !== "verify" && command !== "move") {
  die(USAGE);
}

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  die("Set MIGRATION_DATABASE_URL (or DATABASE_URL)");
}
const concurrency = count(values.concurrency, "concurrency", 4);
const pool = new Pool({ connectionString: url, max: concurrency + 1 });

interface Row {
  owner_id: string;
  sha256: string;
  bytes: string;
  location: string;
  media_type: string;
}

interface Problem {
  owner_id: string;
  sha256: string;
  location: string;
  problem: string;
}

const MiB = 1024 * 1024;
const mb = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB`;

/**
 * Every object that is not deleted, in pages, in key order.
 * @yields one content_objects row at a time
 */
async function* objects(filter: { owner?: string; location?: string }): AsyncGenerator<Row> {
  let after: [string, string] = ["", ""];
  for (;;) {
    const params: unknown[] = [after[0], after[1]];
    let sql = `SELECT owner_id, sha256, bytes::text AS bytes, location, media_type
               FROM content_objects
               WHERE deleted_at IS NULL AND (owner_id, sha256) > ($1, $2)`;
    if (filter.owner) {
      params.push(filter.owner);
      sql += ` AND owner_id = $${params.length}`;
    }
    if (filter.location) {
      params.push(filter.location);
      sql += ` AND location = $${params.length}`;
    }
    sql += " ORDER BY owner_id, sha256 LIMIT 500";
    const { rows } = await pool.query<Row>(sql, params);
    if (rows.length === 0) {
      return;
    }
    yield* rows;
    const last = rows.at(-1) as Row;
    after = [last.owner_id, last.sha256];
  }
}

/** Run `work` over `items`, `concurrency` at a time: workers take turns at one iterator. */
async function each<T>(items: AsyncIterable<T>, work: (item: T) => Promise<void>): Promise<void> {
  const iterator = items[Symbol.asyncIterator]();
  async function worker(): Promise<void> {
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      await work(next.value);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/** The bytes of an object at a location, checked against its hash. */
async function readAt(location: ContentLocation, ownerId: string, sha256: string): Promise<Held> {
  if (location === "db") {
    const { rows } = await pool.query<{ data: Buffer }>(
      "SELECT data FROM content_blobs WHERE owner_id = $1 AND sha256 = $2",
      [ownerId, sha256],
    );
    if (rows.length === 0) {
      throw new ContentStoreError("missing", `no database copy of content ${sha256}`);
    }
    return verifyBlob(sha256, rows[0].data);
  }
  if (location === "s3") {
    return getS3Object(ownerId, sha256, config);
  }
  return readFileObject(ownerId, sha256);
}

function problemOf(row: Row, error: unknown): Problem {
  const problem =
    error instanceof ContentStoreError
      ? `${error.kind}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { location: row.location, owner_id: row.owner_id, problem, sha256: row.sha256 };
}

function report(summary: Record<string, unknown>, lines: string[]): void {
  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const line of lines) {
      console.log(line);
    }
  }
}

async function census(): Promise<number> {
  const byLocation = await pool.query<{ location: string; objects: string; bytes: string }>(
    `SELECT location, count(*)::text AS objects, coalesce(sum(bytes), 0)::text AS bytes
     FROM content_objects WHERE deleted_at IS NULL GROUP BY location ORDER BY location`,
  );
  const deleted = await pool.query<{ objects: string }>(
    "SELECT count(*)::text AS objects FROM content_objects WHERE deleted_at IS NOT NULL",
  );
  const moves = await pool.query<{
    location: string;
    target: string;
    objects: string;
    bytes: string;
  }>(
    `SELECT location, target, count(*)::text AS objects, coalesce(sum(bytes), 0)::text AS bytes
     FROM (SELECT location, bytes,
                  CASE WHEN $1::bigint > 0 AND bytes <= $1::bigint THEN 'db' ELSE $2 END AS target
           FROM content_objects WHERE deleted_at IS NULL) placed
     WHERE location <> target GROUP BY location, target ORDER BY location, target`,
    [config.inlineMax, config.store],
  );
  const heldBack = await pool.query<{ objects: string; bytes: string }>(
    `SELECT count(*)::text AS objects, coalesce(sum(bytes), 0)::text AS bytes
     FROM content_objects
     WHERE deleted_at IS NULL AND location = 'db' AND bytes > $1::bigint`,
    [config.inlineMax],
  );
  const plain = await pool.query<{
    media_type: string;
    objects: string;
    bytes: string;
    owners: string;
  }>(
    `SELECT media_type, count(*)::text AS objects, coalesce(sum(bytes), 0)::text AS bytes,
            count(DISTINCT owner_id)::text AS owners
     FROM content_objects
     WHERE deleted_at IS NULL AND media_type <> 'application/octet-stream'
     GROUP BY media_type ORDER BY count(*) DESC`,
  );
  const summary = {
    by_location: Object.fromEntries(
      byLocation.rows.map((row) => [
        row.location,
        { bytes: Number(row.bytes), objects: Number(row.objects) },
      ]),
    ),
    deleted: Number(deleted.rows[0].objects),
    in_database_above_inline_limit: {
      bytes: Number(heldBack.rows[0].bytes),
      objects: Number(heldBack.rows[0].objects),
    },
    not_encrypted: plain.rows.map((row) => ({
      bytes: Number(row.bytes),
      media_type: row.media_type,
      objects: Number(row.objects),
      owners: Number(row.owners),
    })),
    settings: where(config),
    would_move: moves.rows.map((row) => ({
      bytes: Number(row.bytes),
      from: row.location,
      objects: Number(row.objects),
      to: row.target,
    })),
  };
  const lines = [
    `settings: ${summary.settings}`,
    "objects (not deleted), by where their bytes are:",
  ];
  for (const location of CONTENT_LOCATIONS) {
    const here = summary.by_location[location] ?? { bytes: 0, objects: 0 };
    lines.push(`  ${location}  ${here.objects} objects, ${mb(here.bytes)}`);
  }
  lines.push(`deleted: ${summary.deleted} objects`);
  if (summary.would_move.length === 0) {
    lines.push("the current settings move nothing");
  }
  for (const step of summary.would_move) {
    lines.push(`would move ${step.from} → ${step.to}: ${step.objects} objects, ${mb(step.bytes)}`);
  }
  if (summary.in_database_above_inline_limit.objects > 0) {
    lines.push(
      `in the database although larger than the inline limit (the object store refused them): ${summary.in_database_above_inline_limit.objects} objects, ${mb(summary.in_database_above_inline_limit.bytes)}`,
    );
  }
  const plainObjects = summary.not_encrypted.reduce((sum, row) => sum + row.objects, 0);
  lines.push(
    `not encrypted (a media type other than application/octet-stream): ${plainObjects} objects`,
  );
  for (const row of summary.not_encrypted) {
    lines.push(
      `  ${row.media_type}: ${row.objects} objects, ${mb(row.bytes)}, ${row.owners} owners`,
    );
  }
  report(summary, lines);
  return 0;
}

async function verify(): Promise<number> {
  if (values.location !== undefined && !isContentLocation(values.location)) {
    die("--location must be fs, db or s3");
  }
  const checked: Record<string, { objects: number; bytes: number }> = {};
  const problems: Problem[] = [];
  let seen = 0;
  await each(objects({ location: values.location, owner: values.owner }), async (row) => {
    const location = isContentLocation(row.location) ? row.location : "fs";
    try {
      const held = await readAt(location, row.owner_id, row.sha256);
      await release(held);
      const tally = (checked[location] ??= { bytes: 0, objects: 0 });
      tally.objects += 1;
      tally.bytes += held.size;
    } catch (error) {
      problems.push(problemOf(row, error));
    }
    seen += 1;
    if (!values.json && seen % 1000 === 0) {
      console.log(`  … ${seen} objects read`);
    }
  });
  const summary = { checked, problem_count: problems.length, problems: problems.slice(0, 50) };
  const lines = Object.entries(checked).map(
    ([location, tally]) =>
      `${location}: ${tally.objects} objects, ${mb(tally.bytes)} match their hash`,
  );
  lines.push(`problems: ${problems.length}`);
  for (const problem of problems.slice(0, 50)) {
    lines.push(`  ${problem.owner_id} ${problem.sha256} (${problem.location}) ${problem.problem}`);
  }
  report(summary, lines);
  return problems.length > 0 ? 4 : 0;
}

/** Put one object's bytes at `to`, read them back from there, then switch its row. */
async function moveOne(row: Row, from: ContentLocation, to: ContentLocation): Promise<boolean> {
  const held = await readAt(from, row.owner_id, row.sha256);
  try {
    if (to === "fs") {
      let there = await fileObjectExists(row.owner_id, row.sha256);
      if (there) {
        try {
          await release(await readFileObject(row.owner_id, row.sha256));
        } catch (error) {
          // A file that fails its hash check is replaced by the checked bytes.
          if (!(error instanceof ContentStoreError && error.kind === "integrity")) {
            throw error;
          }
          there = false;
        }
      }
      if (!there) {
        await writeFileObject(row.owner_id, row.sha256, held);
      }
    } else if (to === "s3") {
      await putS3Object(row.owner_id, row.sha256, held, config);
    } else {
      const data = await bufferOf(held);
      await pool.query(
        `INSERT INTO content_blobs (owner_id, sha256, data) VALUES ($1, $2, $3)
         ON CONFLICT (owner_id, sha256) DO NOTHING`,
        [row.owner_id, row.sha256, data],
      );
    }
    await release(await readAt(to, row.owner_id, row.sha256));
  } finally {
    await release(held);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const switched = await client.query(
      `UPDATE content_objects SET location = $3
       WHERE owner_id = $1 AND sha256 = $2 AND location = $4 AND deleted_at IS NULL`,
      [row.owner_id, row.sha256, to, from],
    );
    if (switched.rowCount === 1 && from === "db") {
      await client.query("DELETE FROM content_blobs WHERE owner_id = $1 AND sha256 = $2", [
        row.owner_id,
        row.sha256,
      ]);
    }
    await client.query("COMMIT");
    return switched.rowCount === 1;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function move(): Promise<number> {
  if (values.to !== undefined && values.to !== "fs") {
    die("--to only takes fs (moving back into files); otherwise the settings say where objects go");
  }
  const limit = count(values.limit, "limit", Number.POSITIVE_INFINITY);
  const dryRun = values["dry-run"];
  const moved: Record<string, { objects: number; bytes: number }> = {};
  const problems: Problem[] = [];
  let inPlace = 0;
  let changedMeanwhile = 0;
  let started = 0;
  async function* due(): AsyncGenerator<[Row, ContentLocation, ContentLocation]> {
    for await (const row of objects({ owner: values.owner })) {
      const from = isContentLocation(row.location) ? row.location : "fs";
      const to: ContentLocation = values.to === "fs" ? "fs" : placement(Number(row.bytes), config);
      if (from === to) {
        inPlace += 1;
        continue;
      }
      if (started >= limit) {
        return;
      }
      started += 1;
      yield [row, from, to];
    }
  }
  await each(due(), async ([row, from, to]) => {
    const key = `${from}→${to}`;
    try {
      if (!dryRun && !(await moveOne(row, from, to))) {
        changedMeanwhile += 1;
        return;
      }
      const tally = (moved[key] ??= { bytes: 0, objects: 0 });
      tally.objects += 1;
      tally.bytes += Number(row.bytes);
      const total = Object.values(moved).reduce((sum, t) => sum + t.objects, 0);
      if (!values.json && total % 1000 === 0) {
        console.log(`  … ${total} objects ${dryRun ? "to move" : "moved"}`);
      }
    } catch (error) {
      problems.push(problemOf(row, error));
    }
  });
  const summary = {
    already_in_place: inPlace,
    changed_meanwhile: changedMeanwhile,
    dry_run: dryRun,
    moved,
    problem_count: problems.length,
    problems: problems.slice(0, 50),
    settings: values.to === "fs" ? "everything back into files" : where(config),
  };
  const lines = [`settings: ${summary.settings}${dryRun ? " (dry run: nothing is changed)" : ""}`];
  for (const [key, tally] of Object.entries(moved)) {
    lines.push(
      `${dryRun ? "would move" : "moved"} ${key}: ${tally.objects} objects, ${mb(tally.bytes)}`,
    );
  }
  lines.push(`already in place: ${inPlace}`);
  if (changedMeanwhile > 0) {
    lines.push(`changed or deleted while moving, left as they were: ${changedMeanwhile}`);
  }
  lines.push(`problems: ${problems.length}`);
  for (const problem of problems.slice(0, 50)) {
    lines.push(`  ${problem.owner_id} ${problem.sha256} (${problem.location}) ${problem.problem}`);
  }
  report(summary, lines);
  return problems.length > 0 ? 4 : 0;
}

let status = 0;
try {
  status =
    command === "census" ? await census() : command === "verify" ? await verify() : await move();
} finally {
  await pool.end();
}
process.exit(status);
