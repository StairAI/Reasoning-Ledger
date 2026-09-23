import { call } from "@orpc/server";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerAgent } from "#/routes/agents";
import { submitRecord } from "#/routes/records";
import { ctx, makeObservingInput, makeTestOwner } from "./helpers";
import type { TestOwner } from "./helpers";

const apiServer = path.resolve(import.meta.dirname, "../..");

function exportRecords(...args: string[]) {
  return execFileSync("node", ["scripts/export-records.mts", ...args], {
    cwd: apiServer,
    env: process.env,
    stdio: "pipe",
  }).toString();
}

function batches(dir: string) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .toSorted();
}

function exportedIds(dir: string): string[] {
  return batches(dir).flatMap((name) =>
    readFileSync(path.join(dir, name), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((text) => (JSON.parse(text) as { record_id: string }).record_id),
  );
}

describe("WORM export", () => {
  let owner: TestOwner;
  let agentId: string;
  let out: string;
  const submitted: string[] = [];

  async function submit() {
    const input = makeObservingInput(agentId);
    await call(submitRecord, input, ctx(owner.apiKey));
    submitted.push(input.record_id);
  }

  beforeAll(async () => {
    out = mkdtempSync(path.join(tmpdir(), "rl-export-"));
    owner = await makeTestOwner();
    const reg = await call(
      registerAgent,
      { name: `export-agent-${crypto.randomUUID()}` },
      ctx(owner.apiKey),
    );
    agentId = reg.agent_id;
    await submit();
    await submit();
  });

  afterAll(async () => {
    await owner.cleanup();
    rmSync(out, { force: true, recursive: true });
  });

  it("exports records in sequence order with a manifest per batch, and verifies them", () => {
    exportRecords("--out", out, "--settle-seconds", "0");
    expect(exportedIds(out)).toStrictEqual(expect.arrayContaining(submitted));

    const [first] = batches(out);
    const manifest = JSON.parse(
      readFileSync(path.join(out, first.replace(/\.jsonl$/, ".manifest.json")), "utf-8"),
    ) as { count: number; first_sequence: number; last_sequence: number };
    const lines = readFileSync(path.join(out, first), "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(manifest.count);
    const sequences = lines.map((text) => (JSON.parse(text) as { sequence: number }).sequence);
    expect(sequences).toStrictEqual(sequences.toSorted((a, b) => a - b));
    expect(sequences[0]).toBe(manifest.first_sequence);
    expect(sequences.at(-1)).toBe(manifest.last_sequence);

    expect(exportRecords("--verify", out)).toContain("verified");
  });

  it("continues after the last exported record and never rewrites a batch", async () => {
    const before = batches(out);
    exportRecords("--out", out, "--settle-seconds", "0");
    expect(batches(out)).toStrictEqual(before);

    await submit();
    exportRecords("--out", out, "--settle-seconds", "0");
    const after = batches(out);
    expect(after).toHaveLength(before.length + 1);
    expect(exportedIds(out)).toContain(submitted.at(-1));
  });

  it("detects a batch that no longer matches its manifest", () => {
    const [first] = batches(out);
    const file = path.join(out, first);
    writeFileSync(file, readFileSync(file, "utf-8").replace('"Observing"', '"Other"'));
    expect(() => exportRecords("--verify", out)).toThrow(/Command failed/);
  });
});
