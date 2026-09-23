/**
 * Export records for write-once storage (design §5). Off by default: the
 * deployer schedules it and copies --out to WORM storage (for example an S3
 * bucket with Object Lock).
 *
 *   pnpm --dir api-server export-records --out <dir> [--batch 10000] [--settle-seconds 60]
 *   pnpm --dir api-server export-records --verify <dir>
 *
 * Each run continues after the highest sequence already exported to <dir> and
 * writes one pair of files per batch, never overwriting:
 *   records-<first>-<last>.jsonl          one record per line, in sequence order
 *   records-<first>-<last>.manifest.json  first/last sequence, count, SHA-256 of the .jsonl
 *
 * Only records received at least --settle-seconds ago are exported, so a slow
 * transaction cannot commit a lower sequence behind an export.
 * --verify checks every batch against its manifest and, record by record,
 * against the database. Needs DATABASE_URL.
 */

import "./env.mts";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { reconstructRecord } from "../src/lib/record.ts";

interface Manifest {
  first_sequence: number;
  last_sequence: number;
  count: number;
  sha256: string;
  exported_at: string;
}

const { values } = parseArgs({
  options: {
    batch: { default: "10000", type: "string" },
    out: { type: "string" },
    "settle-seconds": { default: "60", type: "string" },
    verify: { type: "string" },
  },
});

if (!process.env.DATABASE_URL || (!values.out && !values.verify)) {
  console.error(
    "usage: export-records --out <dir> [--batch n] [--settle-seconds s] | --verify <dir>   (needs DATABASE_URL)",
  );
  process.exit(2);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const line = (row: Parameters<typeof reconstructRecord>[0]) =>
  JSON.stringify(reconstructRecord(row));

function manifests(dir: string): { file: string; manifest: Manifest }[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".manifest.json"))
    .map((name) => ({
      file: path.join(dir, name),
      manifest: JSON.parse(readFileSync(path.join(dir, name), "utf-8")) as Manifest,
    }))
    .toSorted((a, b) => a.manifest.first_sequence - b.manifest.first_sequence);
}

async function exportBatches(client: Client, dir: string) {
  const batch = Number(values.batch);
  const settleMs = Number(values["settle-seconds"]) * 1000;
  let after = Math.max(0, ...manifests(dir).map((m) => m.manifest.last_sequence));
  let written = 0;
  for (;;) {
    const { rows } = await client.query(
      `SELECT * FROM trace_records
       WHERE sequence > $1 AND server_ts_utc <= $2
       ORDER BY sequence LIMIT $3`,
      [after, Date.now() - settleMs, batch],
    );
    if (rows.length === 0) {
      break;
    }
    const first = Number(rows[0].sequence);
    const last = Number(rows.at(-1).sequence);
    const body = `${rows.map((row) => line(row)).join("\n")}\n`;
    const base = path.join(dir, `records-${first}-${last}`);
    writeFileSync(`${base}.jsonl`, body, { flag: "wx" });
    const manifest: Manifest = {
      count: rows.length,
      exported_at: new Date().toISOString(),
      first_sequence: first,
      last_sequence: last,
      sha256: sha256(body),
    };
    writeFileSync(`${base}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    written += rows.length;
    after = last;
  }
  console.log(`exported ${written} records to ${dir}`);
}

async function verifyBatches(client: Client, dir: string) {
  const problems: string[] = [];
  for (const { file, manifest } of manifests(dir)) {
    const jsonl = file.replace(/\.manifest\.json$/, ".jsonl");
    const body = readFileSync(jsonl, "utf-8");
    if (sha256(body) !== manifest.sha256) {
      problems.push(`${path.basename(jsonl)}: SHA-256 differs from its manifest`);
      continue;
    }
    const lines = body.split("\n").filter(Boolean);
    const { rows } = await client.query(
      "SELECT * FROM trace_records WHERE sequence BETWEEN $1 AND $2 ORDER BY sequence",
      [manifest.first_sequence, manifest.last_sequence],
    );
    if (lines.length !== manifest.count || rows.length !== manifest.count) {
      problems.push(
        `${path.basename(jsonl)}: manifest says ${manifest.count}, file has ${lines.length}, database has ${rows.length}`,
      );
      continue;
    }
    for (const [i, row] of rows.entries()) {
      if (line(row) !== lines[i]) {
        problems.push(`${path.basename(jsonl)}: record ${row.record_id} differs from the database`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`verified ${manifests(dir).length} batches in ${dir}`);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await (values.verify
    ? verifyBatches(client, values.verify)
    : exportBatches(client, values.out as string));
} finally {
  await client.end();
}
