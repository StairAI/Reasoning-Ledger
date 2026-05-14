import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { beforeAll, describe, expect, test } from "vitest";
import { LedgerClient } from "reasoning-ledger-sdk";

import { resolveStagingEnv } from "./env.js";
import { StagingTransport } from "./stagingTransport.js";

// Orchestrated cross-SDK synergy: the PYTHON SDK writes records; the
// TYPESCRIPT SDK reads them back and verifies integrity.
//
// Skips if staging credentials are absent, or if no python interpreter is
// available on PATH. The matching test on the Python side does the inverse:
// TS writes, Python reads.

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

describeIfReady("cross-SDK: Python writes → TypeScript reads", () => {
  const env = skip ? null : resolveStagingEnv();
  const transport = skip ? null : new StagingTransport(env!.baseUrl);

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
      httpTransport: transport!,
    });
  });

  test("writer output has all expected record_ids", () => {
    expect(writerOut.session_id).toBe(sessionId);
    expect(writerOut.records.observing).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writerOut.records.toolcalling).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writerOut.records.thinking).toMatch(/^[0-9a-f-]{36}$/i);
    expect(writerOut.records.acting).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("getRecord() can read each record the Python SDK wrote", async () => {
    for (const [kind, rid] of Object.entries(writerOut.records)) {
      const record = await client.getRecord(rid);
      expect(record["record_id"]).toBe(rid);
      expect(record["session_id"]).toBe(sessionId);
      expect(record["agent_id"]).toBe(writerOut.agent_id);

      // Sanity-check the behavior tag round-trips through schema.
      const expectedBehavior = {
        acting: "Acting",
        observing: "Observing",
        thinking: "Thinking",
        toolcalling: "ToolCalling",
      }[kind];
      expect(record["behavior"]).toBe(expectedBehavior);
    }
  });

  test("getSession() returns the four records in submission order", async () => {
    const fetched = await client.getSession(sessionId);
    expect(fetched.session_id).toBe(sessionId);
    expect(fetched.records).toHaveLength(4);

    const order = fetched.records.map((r) => r["record_id"] as string);
    expect(order).toEqual([
      writerOut.records.observing,
      writerOut.records.toolcalling,
      writerOut.records.thinking,
      writerOut.records.acting,
    ]);
  });

  test("ToolCalling upstream_record_id reference survives Python → TS", async () => {
    const tc = await client.getRecord(writerOut.records.toolcalling);
    const upstream = tc["upstream_record_id"] as string[];
    expect(upstream).toEqual([writerOut.records.observing]);

    // And the payload deserializes to the original JSON shape.
    const input = JSON.parse(tc["input_payload"] as string) as Record<string, unknown>;
    expect(input).toEqual({ from: "python" });
  });
});
