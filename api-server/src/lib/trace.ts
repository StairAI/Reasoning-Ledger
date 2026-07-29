/**
 * Client-safe helpers for rendering reasoning-trace records.
 *
 * Pure functions + static metadata only — NO server imports (prisma/auth), so
 * this module is safe to pull into both Astro frontmatter and browser islands.
 *
 * A "record" here is the reconstructed shape returned by the API
 * (`reconstructRecord`): base columns lifted to top level, behaviour-specific
 * payload fields spread in alongside them.
 */

export type Behavior =
  | "Observing"
  | "ToolCalling"
  | "Planning"
  | "Thinking"
  | "Acting"
  | "Reflecting"
  | "Other";

export interface ModelInvocation {
  provider: string;
  model_name: string;
  model_version?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  temperature?: number;
  finish_reason?: string;
  internal_reasoning?: string;
}

export interface TraceRecord {
  record_id: string;
  agent_id: string;
  session_id: string;
  schema_version: string;
  behavior: Behavior;
  client_ts_utc: number;
  server_ts_utc: number;
  notes?: string;
  tags?: string[];
  model_invocation?: ModelInvocation;
  upstream_record_id?: string[];
  parent_record_id?: string;
  // behaviour-specific fields live alongside, accessed via helpers
  [key: string]: unknown;
}

/** Lucide icon key + accent (token) per behaviour type. */
export const BEHAVIOR_META: Record<Behavior, { label: string; icon: IconName; token: string }> = {
  Acting: { icon: "pointer", label: "ACTING", token: "acting" },
  Observing: { icon: "eye", label: "OBSERVING", token: "observing" },
  Other: { icon: "shapes", label: "OTHER", token: "other" },
  Planning: { icon: "list-checks", label: "PLANNING", token: "planning" },
  Reflecting: { icon: "sparkles", label: "REFLECTING", token: "reflecting" },
  Thinking: { icon: "cpu", label: "THINKING", token: "thinking" },
  ToolCalling: { icon: "pen-tool", label: "TOOLCALLING", token: "toolcalling" },
};

/** Legend order, matching the Figma legend. */
export const LEGEND_ORDER: Behavior[] = [
  "Observing",
  "ToolCalling",
  "Planning",
  "Thinking",
  "Acting",
  "Reflecting",
];

export type IconName =
  | "eye"
  | "pen-tool"
  | "list-checks"
  | "brain-circuit"
  | "pointer"
  | "brain"
  | "shapes"
  | "clock"
  | "copy"
  | "x"
  | "chevron-down"
  | "arrow-up"
  | "plus"
  | "minus"
  | "check-circle"
  | "x-circle"
  | "sparkles"
  | "folder"
  | "database"
  | "hash"
  | "cpu"
  | "zap"
  | "arrow-left"
  | "git-fork";

export function behaviorMeta(behavior: string) {
  return BEHAVIOR_META[behavior as Behavior] ?? BEHAVIOR_META.Other;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "10:55:05.164Z" — the compact time shown in node headers. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}Z`;
}

/** "2026-06-10 10:55:05.164Z" — the full timestamp in the inspector. */
export function formatFull(epochMs: number): string {
  const d = new Date(epochMs);
  const date = d.toISOString().slice(0, 10);
  return `${date} ${formatClock(epochMs)}`;
}

/** "13,073" — thousands-separated integer. */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function prettyJSON(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Escape + lightly syntax-highlight a JSON value into HTML (numbers, strings,
 *  booleans/null, keys) for the inspector code blocks. Safe: escapes first. */
export function highlightJSON(value: unknown): string {
  const json = prettyJSON(value) ?? "null";
  const esc = json.replaceAll('&', "&amp;").replaceAll('<', "&lt;").replaceAll('>', "&gt;");
  return esc.replaceAll(
    // biome-ignore lint: standard JSON token regex
    /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = "num";
      if (m.startsWith('"')) {
        cls = m.trimEnd().endsWith(":") ? "key" : "str";
      } else if (m === "true" || m === "false") {
        cls = "bool";
      } else if (m === "null") {
        cls = "null";
      }
      return `<span class="tok-${cls}">${m}</span>`;
    },
  );
}

// ---------------------------------------------------------------------------
// Per-behaviour display extraction (card body + footer + chips)
// ---------------------------------------------------------------------------

export interface CardView {
  /** Primary body line(s) of the node card. */
  description: string;
  /** A neutral chip, e.g. trigger type or action type. */
  chip?: string;
  /** Status tag rendered in the footer. */
  status?: { label: string; kind: "success" | "fail" | "reasoning" | "neutral" };
  /** Model-invocation summary lines, when present. */
  model?: { name: string; tokens?: string };
  /** Whether to show the "↑ N UPSTREAM" footer marker. */
  upstream: number;
}

function str(rec: TraceRecord, key: string): string {
  const v = rec[key];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

export function modelSummary(rec: TraceRecord): CardView["model"] | undefined {
  const mi = rec.model_invocation;
  if (!mi) {
    return undefined;
  }
  const tokens =
    mi.tokens_in != null || mi.tokens_out != null
      ? `${mi.tokens_in ?? 0} → ${mi.tokens_out ?? 0} TOK`
      : undefined;
  return { name: (mi.model_name || mi.provider || "MODEL").toUpperCase(), tokens };
}

export function cardView(rec: TraceRecord): CardView {
  const upstream = rec.upstream_record_id?.length ?? 0;
  const model = modelSummary(rec);

  switch (rec.behavior) {
    case "Observing": {
      return {
        chip: str(rec, "trigger_type").toUpperCase() || undefined,
        description: str(rec, "trigger_description") || str(rec, "trigger_source"),
        upstream: 0,
      };
    }
    case "ToolCalling": {
      const toolName = (rec.tool_meta as Record<string, unknown> | undefined)?.name;
      const name = typeof toolName === "string" ? toolName : "";
      const desc = str(rec, "description");
      return {
        description: name ? `${name} · ${desc}` : desc,
        status: rec.success
          ? { kind: "success", label: "SUCCESS" }
          : { kind: "fail", label: "FAILED" },
        upstream,
      };
    }
    case "Planning": {
      const steps = Array.isArray(rec.steps) ? rec.steps.length : 0;
      return {
        chip: steps ? `${steps} STEPS` : undefined,
        description: str(rec, "goal"),
        upstream,
      };
    }
    case "Thinking": {
      return {
        description: str(rec, "prompt"),
        model,
        status: rec.model_invocation?.internal_reasoning
          ? { kind: "reasoning", label: "REASONING" }
          : undefined,
        upstream,
      };
    }
    case "Acting": {
      const status = str(rec, "execution_status").toUpperCase();
      const kind =
        status === "CONFIRMED" || status === "SIMULATED"
          ? "success"
          : status === "FAILED"
            ? "fail"
            : "neutral";
      return {
        chip: str(rec, "action_type").toUpperCase() || undefined,
        description: str(rec, "action_summary"),
        status: status ? { kind, label: status } : undefined,
        upstream,
      };
    }
    case "Reflecting": {
      return {
        description: str(rec, "output_payload"),
        model,
        upstream,
      };
    }
    default: {
      return {
        description: str(rec, "label") || str(rec, "notes") || rec.behavior,
        upstream,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Inspector "Overview" sections
// ---------------------------------------------------------------------------

export type Section =
  | { kind: "rows"; label: string; rows: [string, string][] }
  | { kind: "text"; label: string; text: string }
  | { kind: "code"; label: string; value: unknown }
  | { kind: "status"; label: string; status: CardView["status"] };

export function overviewSections(rec: TraceRecord): Section[] {
  switch (rec.behavior) {
    case "Observing": {
      return [
        {
          kind: "rows",
          label: "TRIGGER",
          rows: filterRows([
            ["source", str(rec, "trigger_source")],
            ["type", str(rec, "trigger_type")],
            ["external id", str(rec, "external_trigger_id")],
          ]),
        },
        { kind: "text", label: "DESCRIPTION", text: str(rec, "trigger_description") },
        { kind: "text", label: "PAYLOAD SUMMARY", text: str(rec, "trigger_payload_summary") },
      ];
    }
    case "ToolCalling": {
      const meta = (rec.tool_meta as Record<string, unknown>) ?? {};
      return [
        {
          kind: "rows",
          label: "TOOL",
          rows: filterRows([
            ["name", strOf(meta.name)],
            ["endpoint", strOf(meta.endpoint)],
            ["via", strOf(meta.via)],
          ]),
        },
        { kind: "text", label: "DESCRIPTION", text: str(rec, "description") },
        { kind: "code", label: "INPUT", value: rec.input_payload },
        { kind: "code", label: "OUTPUT", value: rec.output_payload },
        {
          kind: "status",
          label: "RESULT",
          status: rec.success
            ? { kind: "success", label: "SUCCESS" }
            : { kind: "fail", label: "FAILED" },
        },
      ];
    }
    case "Planning": {
      const steps = Array.isArray(rec.steps) ? (rec.steps as Record<string, unknown>[]) : [];
      return [
        { kind: "text", label: "GOAL", text: str(rec, "goal") },
        {
          kind: "rows",
          label: "STEPS",
          rows: steps.map((s) => [`${s.index}`, strOf(s.description)]),
        },
        { kind: "code", label: "CONTINGENCIES", value: rec.contingencies },
      ];
    }
    case "Thinking": {
      return [
        {
          kind: "rows",
          label: "MODEL",
          rows: modelRows(rec),
        },
        { kind: "text", label: "PROMPT", text: str(rec, "prompt") },
        { kind: "text", label: "OUTPUT", text: str(rec, "output_payload") },
        ...(rec.model_invocation?.internal_reasoning
          ? [
              {
                kind: "text" as const,
                label: "REASONING",
                text: rec.model_invocation.internal_reasoning,
              },
            ]
          : []),
      ];
    }
    case "Acting": {
      return [
        {
          kind: "rows",
          label: "ACTION",
          rows: filterRows([
            ["type", str(rec, "action_type")],
            ["target", str(rec, "target_system")],
            ["status", str(rec, "execution_status")],
            ["dry run", rec.dry_run ? "true" : "false"],
            ["execution id", str(rec, "execution_id")],
          ]),
        },
        { kind: "text", label: "SUMMARY", text: str(rec, "action_summary") },
        { kind: "code", label: "PARAMETERS", value: rec.parameters },
      ];
    }
    case "Reflecting": {
      return [
        { kind: "text", label: "OUTPUT", text: str(rec, "output_payload") },
        { kind: "code", label: "INPUTS", value: rec.inputs },
      ];
    }
    default: {
      return [
        { kind: "text", label: "LABEL", text: str(rec, "label") },
        { kind: "code", label: "DATA", value: rec.data },
      ];
    }
  }
}

function modelRows(rec: TraceRecord): [string, string][] {
  const mi = rec.model_invocation;
  if (!mi) {
    return [];
  }
  return filterRows([
    ["provider", mi.provider],
    ["model", mi.model_name],
    ["version", mi.model_version ?? ""],
    ["tokens in", mi.tokens_in != null ? String(mi.tokens_in) : ""],
    ["tokens out", mi.tokens_out != null ? String(mi.tokens_out) : ""],
    ["cost usd", mi.cost_usd != null ? String(mi.cost_usd) : ""],
  ]);
}

function filterRows(rows: [string, string][]): [string, string][] {
  return rows.filter(([, v]) => v && v.length > 0);
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/** The behaviour-specific payload (everything that isn't a base column). */
const BASE_KEYS = new Set([
  "record_id",
  "agent_id",
  "session_id",
  "schema_version",
  "behavior",
  "client_ts_utc",
  "server_ts_utc",
  "notes",
  "tags",
  "model_invocation",
  "upstream_record_id",
  "parent_record_id",
]);

export function payloadOnly(rec: TraceRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!BASE_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

/** All dependency record ids (parent first, then upstream), de-duplicated. */
export function depIds(rec: TraceRecord): string[] {
  const ids = [
    ...(rec.parent_record_id ? [rec.parent_record_id] : []),
    ...(rec.upstream_record_id ?? []),
  ];
  return [...new Set(ids)];
}
