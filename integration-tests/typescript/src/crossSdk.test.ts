import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { beforeAll, describe, expect, test } from "vitest";
import { LedgerClient } from "reasoning-ledger-sdk";
import type { ContentRef } from "reasoning-ledger-sdk";

import { resolveStagingEnv } from "./env.js";

// Orchestrated cross-SDK synergy: the PYTHON SDK writes records; the
// TYPESCRIPT SDK reads them back and verifies integrity.
//
// Skips if staging credentials are absent, or if no python interpreter is
// available on PATH. The matching test on the Python side does the inverse:
// TS writes, Python reads. Both writers write the same fixture.

const skip = !process.env["STAIRAI_STAGING_API_KEY"];
const pythonBin = process.env["PYTHON"] ?? "python3";

function pythonAvailable(): boolean {
  try {
    const r = spawnSync(pythonBin, ["--version"], { stdio: "pipe" });
    return r.status === 0;
  } catch {
    return false;
  }
}

const describeIfReady = skip || !pythonAvailable() ? describe.skip : describe;

interface WriterOutput {
  agent_id: string;
  session_id: string;
  records: {
    observing: string;
    toolcalling: string;
    thinking: string;
    acting: string;
  };
}

const EXPECTED_BEHAVIOR: Record<string, string> = {
  acting: "Acting",
  observing: "Observing",
  thinking: "Thinking",
  toolcalling: "ToolCalling",
};

describeIfReady("cross-SDK: Python writes → TypeScript reads", () => {
  const env = skip ? null : resolveStagingEnv();

  // Fresh agent + session per test run so the read-back asserts exactly what
  // this run wrote, not leftovers from a previous invocation.
  const agentName = `it-xsdk-py2ts-${Date.now()}`;
  const sessionId = `xsdk-py2ts-${Date.now()}`;

  let writerOut: WriterOutput;
  let client: LedgerClient;

  beforeAll(() => {
    if (skip) return;

    const runnerPath = join(
      __dirname,
      "..",
      "..",
      "cross-sdk",
      "runners",
      "python_writer.py",
    );
    expect(existsSync(runnerPath)).toBe(true);

    const result = spawnSync(pythonBin, [runnerPath], {
      env: {
        ...process.env,
        AGENT_NAME: agentName,
        SESSION_ID: sessionId,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });

    if (result.status !== 0) {
      throw new Error(
        `python_writer exited ${result.status}\nstdout: ${result.stdout?.toString()}\nstderr: ${result.stderr?.toString()}`,
      );
    }

    const stdout = result.stdout.toString().trim();
    const lastLine = stdout.split("\n").at(-1);
    if (!lastLine) {
      throw new Error(`python_writer produced no stdout. stderr: ${result.stderr?.toString()}`);
    }
    writerOut = JSON.parse(lastLine) as WriterOutput;

    client = new LedgerClient({
      agentId: writerOut.agent_id,
      apiKey: env!.apiKey,
      endpoint: env!.baseUrl,
    });
  });

  test("writer output has all expected record_ids", () => {
    expect(writerOut.session_id).toBe(sessionId);
    expect(writerOut.records.observing).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writerOut.records.toolcalling).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writerOut.records.thinking).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writerOut.records.acting).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("getRecord() reads each record the Python SDK wrote", async () => {
    for (const [kind, rid] of Object.entries(writerOut.records)) {
      const record = await client.getRecord(rid);
      expect(record.record_id).toBe(rid);
      expect(record.agent_id).toBe(writerOut.agent_id);
      expect(record.session_id).toBe(sessionId);
      expect(record.behavior).toBe(EXPECTED_BEHAVIOR[kind]);
    }
  });

  test("getSession() returns the four records in write order", async () => {
    const fetched = await client.getSession(sessionId);
    expect(fetched.session_id).toBe(sessionId);
    expect(fetched.records.map((r) => r.record_id)).toEqual([
      writerOut.records.observing,
      writerOut.records.toolcalling,
      writerOut.records.thinking,
      writerOut.records.acting,
    ]);
  });

  test("ToolCalling upstream_record_id reference survives Python → TS", async () => {
    const tc = await client.getRecord(writerOut.records.toolcalling);
    expect(tc.upstream_record_id).toEqual([writerOut.records.observing]);
  });

  test("ToolCalling.input_payload reads back as the JSON object the writer passed", async () => {
    const tc = await client.getRecord(writerOut.records.toolcalling);
    const bytes = await client.getContent(tc["input_payload"] as ContentRef);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ n: 1, query: "cross-sdk" });
  });

  test("Thinking.prompt reads back as the text the writer passed", async () => {
    const thinking = await client.getRecord(writerOut.records.thinking);
    const bytes = await client.getContent(thinking["prompt"] as ContentRef);
    expect(new TextDecoder().decode(bytes)).toBe("Should we act?");
  });
});
