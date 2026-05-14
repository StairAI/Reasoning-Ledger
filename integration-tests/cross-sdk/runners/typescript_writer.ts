/**
 * Cross-SDK writer runner (TypeScript side).
 *
 * Writes a deterministic 4-record decision cycle to the specified session
 * using the published `reasoning-ledger-sdk` npm package, then prints a JSON
 * object on stdout so a test in another language can invoke this runner and
 * verify the records via its own SDK.
 *
 * Input (env vars):
 *   STAIRAI_STAGING_API_KEY   required
 *   STAIRAI_STAGING_BASE_URL  default https://staging-api.stair-ai.com
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

import { StagingTransport } from "../../typescript/src/stagingTransport.js";

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
  const baseUrl = (process.env["STAIRAI_STAGING_BASE_URL"] ?? "https://staging-api.stair-ai.com")
    .replace(/\/$/, "");
  const agentName = req("AGENT_NAME");
  const sessionId = req("SESSION_ID");

  const transport = new StagingTransport(baseUrl);

  const reg = await LedgerClient.registerAgent(
    {
      apiKey,
      metadata: {
        description: "cross-sdk typescript writer",
        tags: ["integration-test", "cross-sdk", "ts-writer"],
      },
      name: agentName,
    },
    transport,
  );
  const agentId = reg.agent_id;

  const client = new LedgerClient({
    agentId,
    apiKey,
    endpoint: baseUrl,
    httpTransport: transport,
  });
  const session = client.newSession(sessionId);

  const ids = {
    acting: newRecordId(),
    observing: newRecordId(),
    thinking: newRecordId(),
    toolcalling: newRecordId(),
  };

  await session.submit({
    behavior: "Observing",
    record_id: ids.observing,
    trigger_description: "ts-writer: deterministic probe",
    trigger_payload_summary: "probe=ts",
    trigger_source: "cross-sdk",
    trigger_type: "signal_trigger",
  });
  await session.submit({
    behavior: "ToolCalling",
    description: "ts-writer tool call",
    input_payload: JSON.stringify({ from: "typescript" }),
    output_payload: JSON.stringify({ ok: true }),
    record_id: ids.toolcalling,
    success: true,
    tool_meta: { category: "external_api", tool_id: "probe-tool" },
    upstream_record_id: [ids.observing],
  });
  await session.submit({
    behavior: "Thinking",
    inputs: [],
    output_payload: JSON.stringify({ decision: "hold" }),
    prompt: "ts-writer thinking",
    record_id: ids.thinking,
  });
  await session.submit({
    action_summary: "ts-writer acting",
    action_type: "noop",
    behavior: "Acting",
    dry_run: true,
    execution_status: "confirmed",
    parameters: { source: "typescript" },
    record_id: ids.acting,
    target_system: "cross-sdk",
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
