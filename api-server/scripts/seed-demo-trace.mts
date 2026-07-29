/**
 * Seed a rich, design-accurate reasoning trace for the visualiser.
 *
 * Mirrors the Figma example: World Cup 2026 pre-match prediction for fixture
 * 19609127 (Mexico vs South Africa) — 16 records, 5 LLM calls, 13,073 tokens,
 * spanning Observing → ToolCalling → Thinking → Acting → Reflecting.
 *
 * Idempotent: fixed UUIDs + upsert; re-running replaces the demo trace.
 *
 * Run:  pnpm -C api-server exec tsx scripts/seed-demo-trace.mts
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const OWNER_ID = "d0000000-0000-4000-8000-000000000001";
const AGENT_ID = "a0000000-0000-4000-8000-000000000001";
const SESSION_ID = "PREMATCH: 19609127:20260610T105502Z";
const SCHEMA_VERSION = "1.0.0";
const BASE_TS = Date.parse("2026-06-10T10:55:05.164Z");

const rid = (n: number) => `e${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`;

interface Seed {
  n: number;
  behavior: string;
  upstream?: number[];
  model?: { tokens_in: number; tokens_out: number };
  payload: Record<string, unknown>;
}

const haiku = (tokens_in: number, tokens_out: number) => ({
  finish_reason: "stop",
  internal_reasoning:
    "Weighing market-implied probabilities against country-style priors before committing to a fair value.",
  model_name: "claude-haiku-4-5-20251001",
  provider: "anthropic",
  temperature: 0.2,
  tokens_in,
  tokens_out,
});

const RECORDS: Seed[] = [
  {
    behavior: "Observing",
    n: 1,
    payload: {
      external_trigger_id: "cron_wc2026_prematch",
      trigger_description: "Pre-match prediction run for fixture 19609127 (Mexico vs South Africa)",
      trigger_payload_summary:
        "Scheduled 4h before kickoff for all WC2026 fixtures with open Polymarket winner markets.",
      trigger_source: "arena.scheduler",
      trigger_type: "cron_trigger",
    },
  },
  {
    behavior: "ToolCalling",
    n: 2,
    payload: {
      description: "List WC2026 season schedule to discover fixtures",
      input_payload: { season_id: 26_618 },
      output_payload: { picked_fixture_id: 19_609_127, stage_count: 7 },
      success: true,
      tool_meta: {
        endpoint: "/v3/football/schedules/seasons/{season_id}",
        name: "sportmonks",
        via: "arena.sportmonks_proxy",
      },
    },
    upstream: [1],
  },
  {
    behavior: "ToolCalling",
    n: 3,
    payload: {
      description: "Discover available Supabase tables via the public catalog",
      input_payload: { schema: "public" },
      output_payload: { table_count: 12 },
      success: true,
      tool_meta: { endpoint: "/rest/v1/", name: "supabase", via: "arena.supabase" },
    },
    upstream: [1],
  },
  {
    behavior: "ToolCalling",
    n: 4,
    payload: {
      description: "Look up curated Polymarket event_slug for this Sportmonks fixture",
      input_payload: { fixture_id: 19_609_127 },
      output_payload: { event_slug: "mex-vs-rsa-2026-06-10" },
      success: true,
      tool_meta: { endpoint: "/map/event_slug", name: "arena-mapping", via: "arena.internal" },
    },
    upstream: [2],
  },
  {
    behavior: "ToolCalling",
    n: 5,
    payload: {
      description: "Fetch fixture detail with pre-match prediction includes",
      input_payload: { fixture_id: 19_609_127, include: "predictions;participants" },
      output_payload: { away: "South Africa", home: "Mexico", kickoff: "2026-06-10T15:00:00Z" },
      success: true,
      tool_meta: {
        endpoint: "/v3/football/fixtures/{id}",
        name: "sportmonks",
        via: "arena.sportmonks_proxy",
      },
    },
    upstream: [2],
  },
  {
    behavior: "ToolCalling",
    n: 6,
    payload: {
      description: "Fetch Polymarket event + 3 child winner markets by slug",
      input_payload: { slug: "mex-vs-rsa-2026-06-10" },
      output_payload: { markets: 3, outcomes: ["MEX", "DRAW", "RSA"] },
      success: true,
      tool_meta: { endpoint: "/events", name: "polymarket-gamma", via: "arena.polymarket" },
    },
    upstream: [4],
  },
  {
    behavior: "Thinking",
    model: { tokens_in: 1501, tokens_out: 1165 },
    n: 7,
    payload: {
      inputs: [{ input_payload: "Fixture detail + pre-match prediction includes for 19609127." }],
      output_payload:
        "Mexico enters as clear favourite at home altitude; South Africa's low-block style suppresses xG.",
      prompt: "You are a soccer analyst.",
    },
    upstream: [5],
  },
  {
    behavior: "ToolCalling",
    n: 8,
    payload: {
      description: "Fetch ads_a_country_style priors for both teams",
      input_payload: { teams: ["MEX", "RSA"] },
      output_payload: { mex_attack_index: 1.24, rows: 2, rsa_defense_index: 0.91 },
      success: true,
      tool_meta: {
        endpoint: "/rest/v1/ads_a_country_style",
        name: "supabase",
        via: "arena.supabase",
      },
    },
    upstream: [3, 5],
  },
  {
    behavior: "ToolCalling",
    n: 9,
    payload: {
      description: "Fetch CLOB midpoint per outcome YES token (home / draw / away)",
      input_payload: { tokens: ["MEX-YES", "DRAW-YES", "RSA-YES"] },
      output_payload: { DRAW: 0.23, MEX: 0.62, RSA: 0.15 },
      success: true,
      tool_meta: { endpoint: "/prices/midpoint", name: "polymarket-clob", via: "arena.polymarket" },
    },
    upstream: [6],
  },
  {
    behavior: "Thinking",
    model: { tokens_in: 1620, tokens_out: 980 },
    n: 10,
    payload: {
      inputs: [{ input_payload: "ads_a_country_style rows for MEX and RSA." }],
      output_payload:
        "Prior-implied win probability for Mexico ≈ 0.58 once altitude and style mismatch are applied.",
      prompt:
        "You are an analyst aggregating Supabase priors data for one fixture into a self-contained brief.",
    },
    upstream: [8],
  },
  {
    behavior: "Thinking",
    model: { tokens_in: 1400, tokens_out: 900 },
    n: 11,
    payload: {
      inputs: [{ input_payload: "CLOB midpoints + prior-implied probabilities." }],
      output_payload:
        "Blended fair value for MEX win ≈ 0.60; market at 0.62 looks marginally rich.",
      prompt: "Combine market-implied probabilities with model priors.",
    },
    upstream: [9, 10],
  },
  {
    behavior: "Thinking",
    model: { tokens_in: 1750, tokens_out: 1100 },
    n: 12,
    payload: {
      inputs: [{ input_payload: "Analyst read + blended fair value." }],
      output_payload:
        "Edge is thin on the straight winner; a MEX @ 0.42 stake captures value with contained downside.",
      prompt: "Assess edge vs market and calibrate confidence.",
    },
    upstream: [7, 11],
  },
  {
    behavior: "Thinking",
    model: { tokens_in: 1600, tokens_out: 1057 },
    n: 13,
    payload: {
      inputs: [{ input_payload: "Calibrated edge assessment." }],
      output_payload:
        "Final: back Mexico at p=0.42 — altitude, style mismatch, and priors outweigh the modest market richness.",
      prompt: "Draft the final pre-match prediction rationale.",
    },
    upstream: [12],
  },
  {
    behavior: "Acting",
    n: 14,
    payload: {
      action_summary: "Predict MEX @ p=0.42 for fixture 19609127",
      action_type: "prediction",
      dry_run: false,
      execution_id: "pred_19609127_mex",
      execution_status: "confirmed",
      parameters: { fixture_id: 19_609_127, outcome: "MEX", p: 0.42 },
      target_system: "arena.ledger",
    },
    upstream: [13],
  },
  {
    behavior: "Acting",
    n: 15,
    payload: {
      action_summary: "Place YES order on MEX @ 0.40 (size 50)",
      action_type: "order",
      dry_run: false,
      execution_id: "ord_19609127_mex",
      execution_status: "confirmed",
      parameters: { price: 0.4, size: 50, token: "MEX-YES" },
      target_system: "polymarket-clob",
    },
    upstream: [14],
  },
  {
    behavior: "Reflecting",
    n: 16,
    payload: {
      inputs: [{ input_payload: "prediction confirmed at p=0.42", input_record_id: rid(14) }],
      output_payload:
        "Post-trade note: entered MEX YES below model fair value; monitor late lineup news for altitude rotation.",
    },
    upstream: [14, 15],
  },
];

async function main() {
  await prisma.owner.upsert({
    create: {
      api_key_hash: "demo-seed-not-a-real-key-hash",
      display_name: "Stair AI Demo",
      email: "demo@stair-ai.com",
      id: OWNER_ID,
      owner_wallet_address: "0xDEMO0000000000000000000000000000000DEMO",
      wallet_mode: "custodial",
    },
    update: {},
    where: { id: OWNER_ID },
  });

  await prisma.agent.upsert({
    create: {
      agent_wallet_address: "0xAGENT000000000000000000000000000000AGENT",
      description: "World Cup 2026 pre-match prediction agent",
      id: AGENT_ID,
      name: "arena-predictor",
      owner_id: OWNER_ID,
      tags: ["world-cup", "polymarket"],
    },
    update: { name: "arena-predictor" },
    where: { id: AGENT_ID },
  });

  // Fresh slate for this demo session.
  await prisma.traceRecord.deleteMany({ where: { agent_id: AGENT_ID, session_id: SESSION_ID } });

  for (const r of RECORDS) {
    const ts = BASE_TS + r.n * 137; // stagger by ~137ms per step
    await prisma.traceRecord.create({
      data: {
        agent_id: AGENT_ID,
        behavior: r.behavior as never,
        client_ts_utc: BigInt(ts),
        model_invocation: r.model
          ? (haiku(r.model.tokens_in, r.model.tokens_out) as never)
          : undefined,
        payload: r.payload as never,
        record_id: rid(r.n),
        schema_version: SCHEMA_VERSION,
        server_ts_utc: BigInt(ts + 40),
        session_id: SESSION_ID,
        tags: [],
        upstream_record_id: (r.upstream ?? []).map(rid),
      },
    });
  }

  const count = await prisma.traceRecord.count({
    where: { agent_id: AGENT_ID, session_id: SESSION_ID },
  });
  console.log(`Seeded ${count} records for session "${SESSION_ID}" (agent ${AGENT_ID}).`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
