/**
 * Cross-SDK writer runner (TypeScript side).
 *
 * Writes the shared 4-record fixture (Observing → ToolCalling → Thinking →
 * Acting) to the specified session using the workspace `reasoning-ledger-sdk`,
 * then prints a JSON object on stdout so a test in another language can invoke
 * this runner and verify the records via its own SDK. The Python writer
 * (python_writer.py) writes the same fixture.
 *
 * Input (env vars):
 *   STAIRAI_STAGING_API_KEY   required
 *   STAIRAI_STAGING_BASE_URL  default https://stg-api.stair-ai.com
 *   AGENT_NAME                required (already registered or will be created)
 *   SESSION_ID                required
 *
 * Output (stdout, exactly one line, JSON):
 *   {
 *     "agent_id":   "<uuid>",
 *     "session_id": "<session id>",
 *     "records": {
 *       "observing":   "<record_id>",
 *       "toolcalling": "<record_id>",
 *       "thinking":    "<record_id>",
 *       "acting":      "<record_id>"
 *     }
 *   }
 */

import { LedgerClient, newRecordId } from "reasoning-ledger-sdk";

function req(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const apiKey = req("STAIRAI_STAGING_API_KEY");
  const endpoint = process.env["STAIRAI_STAGING_BASE_URL"] ?? "https://stg-api.stair-ai.com";
  const agentName = req("AGENT_NAME");
  const sessionId = req("SESSION_ID");

  const reg = await LedgerClient.registerAgent({
    apiKey,
    endpoint,
    metadata: {
      description: "cross-sdk typescript writer",
      tags: ["integration-test", "cross-sdk", "ts-writer"],
    },
    name: agentName,
  });
  const agentId = reg.agent_id;

  const client = new LedgerClient({ agentId, apiKey, endpoint });
  const session = client.newSession(sessionId);

  const ids = {
    acting: newRecordId(),
    observing: newRecordId(),
    thinking: newRecordId(),
    toolcalling: newRecordId(),
  };

  // 1. Observing.
  await session.submit({
    behavior: "Observing",
    executor: "det",
    record_id: ids.observing,
    record_phase: "post_execution",
    trigger_description: "cross-sdk writer",
    trigger_payload_summary: "cross-sdk",
    trigger_source: "cross-sdk",
    trigger_type: "signal_trigger",
  });

  // 2. ToolCalling. The object payloads are uploaded as application/json.
  // Key order as in the fixture, so both writers upload identical bytes.
  await session.submit({
    behavior: "ToolCalling",
    description: "echo tool",
    executor: "det",
    input_payload: { query: "cross-sdk", n: 1 },
    outcome: "success",
    output_payload: { ok: true },
    record_id: ids.toolcalling,
    record_phase: "post_execution",
    tool_meta: { name: "echo" },
    upstream_record_id: [ids.observing],
  });

  // 3. Thinking. The strings are uploaded as text/plain; charset=utf-8.
  await session.submit({
    behavior: "Thinking",
    executor: "ai",
    inputs: [{ input_payload: "echo ok", input_record_id: ids.toolcalling }],
    output_payload: "Yes",
    prompt: "Should we act?",
    record_id: ids.thinking,
    record_phase: "post_execution",
    upstream_record_id: [ids.toolcalling],
  });

  // 4. Acting.
  await session.submit({
    action_summary: "cross-sdk act",
    action_type: "publish",
    behavior: "Acting",
    dry_run: true,
    executor: "det",
    execution_status: "simulated",
    parameters: {},
    record_id: ids.acting,
    record_phase: "post_execution",
    target_system: "noop",
    upstream_record_id: [ids.thinking],
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      agent_id: agentId,
      records: ids,
      session_id: sessionId,
    }),
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(message);
  process.exit(1);
});
