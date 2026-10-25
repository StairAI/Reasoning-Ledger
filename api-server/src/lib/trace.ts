/**
 * Client-safe helpers for rendering reasoning-trace records.
 *
 * Pure functions + static metadata only — NO server imports (prisma/auth), so
 * this module is safe to pull into both Astro frontmatter and browser islands.
 *
 * A "record" here is the reconstructed shape returned by the API
 * (`reconstructRecord`): base columns lifted to top level, behaviour-specific
 * payload fields spread in alongside them.
 *
 * Content positions (prompts, outputs, tool payloads, model reasoning, and from
 * 0.5 what an escalation asked, a delegated goal and its result, and what a
 * memory write stored) hold the value itself in schema 0.1–0.3 records and a
 * ContentRef from 0.4. The server resolves the references a page needs into a
 * ContentMap (lib/content-view.ts); the view helpers below take it and show the
 * content, or say why they cannot.
 *
 * Stored records keep the shape they were written in, so the helpers still
 * render what 0.5 dropped: parent_record_id, model_version.
 */

/** Every behaviour a stored record may carry. */
export type Behavior =
  | "Observing"
  | "ToolCalling"
  | "Planning"
  | "Thinking"
  | "Acting"
  | "Reflecting"
  | "Attesting"
  | "Escalating"
  | "Delegating"
  | "Memorizing"
  | "Other";

export interface ContentRef {
  sha256: string;
  bytes: number;
  media_type: string;
}

/** What the viewer can show for one piece of referenced content. */
export type ContentView =
  | { state: "text"; text: string }
  | { state: "json"; value: unknown }
  | { state: "binary" | "too_large" | "deleted" | "missing" | "unreadable" };

/** Resolved content, keyed by SHA-256. */
export type ContentMap = Record<string, ContentView>;

export interface ModelInvocation {
  /** Null from 0.5 when the invocation is a replay or simulated. */
  provider: string | null;
  model_name: string | null;
  /** Records before 0.5 only; 0.5 folds it into model_name. */
  model_version?: string;
  /** From 0.5: live, replay, cached or simulated. */
  invocation_kind?: string;
  /** From 0.5: the record id, or the content, that a replay reproduces. */
  replay_of?: string | ContentRef;
  tokens_in?: number;
  tokens_out?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cost_usd?: number;
  temperature?: number;
  finish_reason?: string;
  request_id?: string;
  /** Text in 0.1–0.3 records, a ContentRef from 0.4. */
  internal_reasoning?: string | ContentRef;
}

/** How a 0.5 record came to carry its behaviour. */
export interface Classification {
  source: string;
  mapper?: string;
  confidence?: number;
  alternatives?: { behavior: string; confidence: number }[];
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
  /** Records before 0.5 only: the record whose sub-thread this one ran in. */
  parent_record_id?: string;
  /** Position in the server's total order. */
  sequence?: number;
  // Schema 0.4 base fields.
  executor?: string;
  record_phase?: string;
  outcome?: string;
  duration_ms?: number;
  // Schema 0.5 base fields (written_by was Attesting's own in 0.4).
  error_type?: string;
  written_by?: { component: string; credential: string };
  on_behalf_of_agent_id?: string;
  classification?: Classification;
  // behaviour-specific fields live alongside, accessed via helpers
  [key: string]: unknown;
}

/** Lucide icon key, accent colour and token per behaviour type. */
export const BEHAVIOR_META: Record<
  Behavior,
  { color: string; label: string; icon: IconName; token: string }
> = {
  Acting: { color: "#00b2a4", icon: "pointer", label: "ACTING", token: "acting" },
  Attesting: { color: "#e8e2d6", icon: "check-circle", label: "ATTESTING", token: "attesting" },
  Delegating: { color: "#7c8cf8", icon: "bot", label: "DELEGATING", token: "delegating" },
  Escalating: {
    color: "#f0884a",
    icon: "message-circle-question-mark",
    label: "ESCALATING",
    token: "escalating",
  },
  Memorizing: { color: "#c5d85a", icon: "notebook-pen", label: "MEMORIZING", token: "memorizing" },
  Observing: { color: "#ebb447", icon: "eye", label: "OBSERVING", token: "observing" },
  Other: { color: "#9a9a9a", icon: "shapes", label: "OTHER", token: "other" },
  Planning: { color: "#7ee055", icon: "list-checks", label: "PLANNING", token: "planning" },
  Reflecting: { color: "#e06c7f", icon: "sparkles", label: "REFLECTING", token: "reflecting" },
  Thinking: { color: "#bf80ff", icon: "cpu", label: "THINKING", token: "thinking" },
  ToolCalling: { color: "#3c9add", icon: "pen-tool", label: "TOOLCALLING", token: "toolcalling" },
};

/**
 * Legend order: the behaviours a 0.5 record can carry, in the order they fall in
 * a cycle, with Escalating next to the Attesting that answers it. Other keeps
 * its style but has no entry.
 */
export const LEGEND_ORDER: Behavior[] = [
  "Observing",
  "ToolCalling",
  "Planning",
  "Thinking",
  "Escalating",
  "Attesting",
  "Delegating",
  "Memorizing",
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
  | "message-circle-question-mark"
  | "bot"
  | "notebook-pen"
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
  const esc = json.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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
// Content positions
// ---------------------------------------------------------------------------

function isContentRef(value: unknown): value is ContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ContentRef).sha256 === "string" &&
    typeof (value as ContentRef).bytes === "number" &&
    typeof (value as ContentRef).media_type === "string"
  );
}

function unavailable(ref: ContentRef, view: ContentView | undefined): string {
  const what = `${formatNumber(ref.bytes)} bytes, ${ref.media_type}`;
  switch (view?.state) {
    case "binary": {
      return `[binary content: ${what}]`;
    }
    case "too_large": {
      return `[too large to show here: ${what}]`;
    }
    case "deleted": {
      return `[content deleted: ${what}]`;
    }
    case "unreadable": {
      return `[content failed its integrity check: ${what}]`;
    }
    default: {
      return `[content not available: ${what}]`;
    }
  }
}

/** Text for a content position, for the prose sections and card bodies. */
export function contentText(value: unknown, contents: ContentMap): string {
  if (!isContentRef(value)) {
    if (typeof value === "string") {
      return value;
    }
    return value === null || value === undefined ? "" : prettyJSON(value);
  }
  const view = contents[value.sha256];
  if (view?.state === "text") {
    return view.text;
  }
  return view?.state === "json" ? prettyJSON(view.value) : unavailable(value, view);
}

/** A value for a content position, for the JSON code blocks. */
export function contentValue(value: unknown, contents: ContentMap): unknown {
  if (!isContentRef(value)) {
    return value;
  }
  const view = contents[value.sha256];
  if (view?.state === "json") {
    return view.value;
  }
  return view?.state === "text" ? view.text : unavailable(value, view);
}

function resolvedInputs(inputs: unknown, contents: ContentMap): unknown {
  if (!Array.isArray(inputs)) {
    return inputs;
  }
  return inputs.map((input: unknown) =>
    typeof input === "object" && input !== null
      ? {
          ...input,
          input_payload: contentValue((input as Record<string, unknown>).input_payload, contents),
        }
      : input,
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
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

export function modelSummary(rec: TraceRecord): CardView["model"] | undefined {
  const mi = rec.model_invocation;
  if (!mi) {
    return undefined;
  }
  const tokens =
    (mi.tokens_in !== null && mi.tokens_in !== undefined) ||
    (mi.tokens_out !== null && mi.tokens_out !== undefined)
      ? `${mi.tokens_in ?? 0} → ${mi.tokens_out ?? 0} TOK`
      : undefined;
  return { name: (mi.model_name || mi.provider || "MODEL").toUpperCase(), tokens };
}

type Status = NonNullable<CardView["status"]>;

const OUTCOME_KIND: Record<string, Status["kind"]> = {
  cancelled: "neutral",
  denied: "fail",
  escalated: "neutral",
  failure: "fail",
  success: "success",
  timeout: "fail",
};

/** A record's result: `outcome` from 0.4, a tool call's boolean `success` before. */
function outcomeStatus(rec: TraceRecord): CardView["status"] {
  if (typeof rec.outcome === "string") {
    return { kind: OUTCOME_KIND[rec.outcome] ?? "neutral", label: rec.outcome.toUpperCase() };
  }
  if (typeof rec.success === "boolean") {
    return rec.success ? { kind: "success", label: "SUCCESS" } : { kind: "fail", label: "FAILED" };
  }
  return undefined;
}

const DISPOSITION: Record<string, Status> = {
  approve: { kind: "success", label: "APPROVED" },
  cancel: { kind: "neutral", label: "CANCELLED" },
  edit: { kind: "neutral", label: "EDITED" },
  no_response: { kind: "fail", label: "NO RESPONSE" },
  reject: { kind: "fail", label: "REJECTED" },
};

/** A neutral chip from one or more of the record's fields, e.g. "ADD · PROJECT". */
function chipOf(rec: TraceRecord, ...keys: string[]): string | undefined {
  const text = keys
    .map((key) => str(rec, key))
    .filter(Boolean)
    .join(" · ");
  return text ? text.toUpperCase() : undefined;
}

/** "3 STEPS" when the record carries an explicit plan. */
function stepsChip(rec: TraceRecord): string | undefined {
  const steps = Array.isArray(rec.steps) ? rec.steps.length : 0;
  return steps ? `${steps} STEPS` : undefined;
}

export function cardView(rec: TraceRecord, contents: ContentMap = {}): CardView {
  const upstream = rec.upstream_record_id?.length ?? 0;
  const model = modelSummary(rec);

  switch (rec.behavior) {
    case "Observing": {
      return {
        chip: chipOf(rec, "trigger_type"),
        description: str(rec, "trigger_description") || str(rec, "trigger_source"),
        upstream: 0,
      };
    }
    case "ToolCalling": {
      return toolCallingCard(rec, upstream);
    }
    case "Planning": {
      return { chip: stepsChip(rec), description: str(rec, "goal"), upstream };
    }
    case "Thinking": {
      return thinkingCard(rec, contents, upstream);
    }
    case "Acting": {
      return actingCard(rec, upstream);
    }
    case "Reflecting": {
      return {
        chip: chipOf(rec, "kind"),
        description: contentText(rec.output_payload, contents),
        model,
        upstream,
      };
    }
    case "Attesting": {
      return attestingCard(rec, upstream);
    }
    case "Escalating": {
      return {
        chip: chipOf(rec, "kind"),
        description: contentText(rec.asked, contents),
        status: outcomeStatus(rec),
        upstream,
      };
    }
    case "Delegating": {
      return delegatingCard(rec, contents, upstream);
    }
    case "Memorizing": {
      return {
        chip: chipOf(rec, "op", "scope"),
        description: contentText(rec.target, contents),
        status: outcomeStatus(rec),
        upstream,
      };
    }
    default: {
      return {
        chip: chipOf(rec, "proposed_behavior"),
        description: str(rec, "label") || str(rec, "notes") || rec.behavior,
        upstream,
      };
    }
  }
}

function toolCallingCard(rec: TraceRecord, upstream: number): CardView {
  const toolName = (rec.tool_meta as Record<string, unknown> | undefined)?.name;
  const name = typeof toolName === "string" ? toolName : "";
  return {
    // The description is optional from 0.5.
    description: [name, str(rec, "description")].filter(Boolean).join(" · "),
    status: outcomeStatus(rec),
    upstream,
  };
}

function thinkingCard(rec: TraceRecord, contents: ContentMap, upstream: number): CardView {
  return {
    // The prompt is optional from 0.5; without one, show what the thinking produced.
    description: contentText(rec.prompt ?? rec.output_payload, contents),
    model: modelSummary(rec),
    status: rec.model_invocation?.internal_reasoning
      ? { kind: "reasoning", label: "REASONING" }
      : undefined,
    upstream,
  };
}

function delegatingCard(rec: TraceRecord, contents: ContentMap, upstream: number): CardView {
  const delegate = str(rec, "delegate_agent_id");
  const goal = contentText(rec.goal, contents);
  return {
    chip: chipOf(rec, "kind"),
    description: delegate ? `${delegate} · ${goal}` : goal,
    status: outcomeStatus(rec),
    upstream,
  };
}

function attestingCard(rec: TraceRecord, upstream: number): CardView {
  const operator = str(rec, "operator_id");
  const reason = str(rec, "reason");
  return {
    chip: str(rec, "gate_kind").toUpperCase() || undefined,
    description: reason ? `${operator} · ${reason}` : operator,
    status: DISPOSITION[str(rec, "disposition")],
    upstream,
  };
}

function actingCard(rec: TraceRecord, upstream: number): CardView {
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

// ---------------------------------------------------------------------------
// Inspector "Overview" sections
// ---------------------------------------------------------------------------

export type Section =
  | { kind: "rows"; label: string; rows: [string, string][] }
  | { kind: "text"; label: string; text: string }
  | { kind: "code"; label: string; value: unknown }
  | { kind: "status"; label: string; status: CardView["status"] };

/** Inspector sections: the record's base fields, its behaviour, then its judgment basis. */
export function overviewSections(rec: TraceRecord, contents: ContentMap = {}): Section[] {
  const base = recordRows(rec);
  return [
    ...(base.length > 0 ? [{ kind: "rows" as const, label: "RECORD", rows: base }] : []),
    ...behaviorSections(rec, contents),
    ...optionalCode("VERDICT", rec.verdict),
    ...optionalCode("SOURCES", rec.sources),
  ];
}

/** Behaviours that show their outcome as a status in their own section instead of a row here. */
const OUTCOME_SECTIONS = new Set<string>(["ToolCalling", "Escalating", "Delegating", "Memorizing"]);

function recordRows(rec: TraceRecord): [string, string][] {
  return filterRows([
    ["executor", strOf(rec.executor)],
    ["phase", strOf(rec.record_phase).replaceAll("_", " ")],
    ["outcome", OUTCOME_SECTIONS.has(rec.behavior) ? "" : strOf(rec.outcome)],
    ["error type", strOf(rec.error_type)],
    [
      "duration",
      rec.duration_ms === null || rec.duration_ms === undefined
        ? ""
        : `${formatNumber(rec.duration_ms)} ms`,
    ],
    ["written by", writtenByText(rec.written_by)],
    ["on behalf of", strOf(rec.on_behalf_of_agent_id)],
    ...classificationRows(rec.classification),
    ["sequence", strOf(rec.sequence)],
  ]);
}

function writtenByText(value: unknown): string {
  const writtenBy = (value ?? {}) as Record<string, unknown>;
  return [strOf(writtenBy.component), strOf(writtenBy.credential)].filter(Boolean).join(" · ");
}

/** "rule · mapper@1 · 0.8", then the behaviours it was weighed against. */
function classificationRows(value: unknown): [string, string][] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const { alternatives, confidence, mapper, source } = value as Record<string, unknown>;
  const others = Array.isArray(alternatives)
    ? alternatives.map(
        (alt: Record<string, unknown>) => `${strOf(alt.behavior)} ${strOf(alt.confidence)}`,
      )
    : [];
  return [
    [
      "classification",
      [strOf(source), strOf(mapper), strOf(confidence)].filter(Boolean).join(" · "),
    ],
    ["alternatives", others.join(", ")],
  ];
}

function optionalCode(label: string, value: unknown): Section[] {
  return value === undefined ? [] : [{ kind: "code", label, value }];
}

function optionalText(label: string, text: string): Section[] {
  return text ? [{ kind: "text", label, text }] : [];
}

function optionalRows(label: string, rows: [string, string][]): Section[] {
  const shown = filterRows(rows);
  return shown.length > 0 ? [{ kind: "rows", label, rows: shown }] : [];
}

function behaviorSections(rec: TraceRecord, contents: ContentMap): Section[] {
  switch (rec.behavior) {
    case "Observing": {
      return [
        {
          kind: "rows",
          label: "TRIGGER",
          rows: filterRows([
            ["source", str(rec, "trigger_source")],
            ["type", str(rec, "trigger_type")],
          ]),
        },
        { kind: "text", label: "DESCRIPTION", text: str(rec, "trigger_description") },
        { kind: "text", label: "PAYLOAD SUMMARY", text: str(rec, "trigger_payload_summary") },
      ];
    }
    case "ToolCalling": {
      return toolCallingSections(rec, contents);
    }
    case "Planning": {
      return [
        { kind: "text", label: "GOAL", text: str(rec, "goal") },
        // The plan this one revises (0.5).
        ...optionalRows("PLAN", [["revision of", str(rec, "revision_of")]]),
        { kind: "rows", label: "STEPS", rows: stepRows(rec.steps) },
        { kind: "code", label: "CONTINGENCIES", value: rec.contingencies },
      ];
    }
    case "Thinking": {
      return thinkingSections(rec, contents);
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
            ["execution id", str(rec, "execution_id")],
          ]),
        },
        { kind: "text", label: "SUMMARY", text: str(rec, "action_summary") },
        ...optionalCode("PARAMETERS", rec.parameters),
      ];
    }
    case "Reflecting": {
      return [
        ...optionalRows("REFLECTION", [["kind", str(rec, "kind")]]),
        { kind: "text", label: "OUTPUT", text: contentText(rec.output_payload, contents) },
        { kind: "code", label: "INPUTS", value: resolvedInputs(rec.inputs, contents) },
      ];
    }
    case "Attesting": {
      return attestingSections(rec, contents);
    }
    case "Escalating": {
      return escalatingSections(rec, contents);
    }
    case "Delegating": {
      return delegatingSections(rec, contents);
    }
    case "Memorizing": {
      return memorizingSections(rec, contents);
    }
    default: {
      return [
        { kind: "text", label: "LABEL", text: str(rec, "label") },
        ...optionalText("PROPOSED BEHAVIOR", str(rec, "proposed_behavior")),
        { kind: "code", label: "DATA", value: rec.data },
      ];
    }
  }
}

function toolCallingSections(rec: TraceRecord, contents: ContentMap): Section[] {
  const meta = (rec.tool_meta as Record<string, unknown>) ?? {};
  return [
    {
      kind: "rows",
      label: "TOOL",
      rows: filterRows([
        ["name", strOf(meta.name)],
        ["type", strOf(meta.tool_type)],
        ["namespace", strOf(meta.namespace)],
        ["server", strOf(meta.server)],
        ["version", strOf(meta.version)],
        ["call id", strOf(meta.call_id)],
        ["effect", str(rec, "effect")],
        ["endpoint", strOf(meta.endpoint)],
        ["via", strOf(meta.via)],
      ]),
    },
    ...optionalText("DESCRIPTION", str(rec, "description")),
    { kind: "code", label: "INPUT", value: contentValue(rec.input_payload, contents) },
    { kind: "code", label: "OUTPUT", value: contentValue(rec.output_payload, contents) },
    { kind: "status", label: "RESULT", status: outcomeStatus(rec) },
  ];
}

/** A plan's steps as rows: the index, then the step and the steps it waits on. */
function stepRows(value: unknown): [string, string][] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((step: Record<string, unknown>): [string, string] => {
    const after = Array.isArray(step.depends_on) ? step.depends_on.join(", ") : "";
    return [
      strOf(step.index),
      after ? `${strOf(step.description)} (after ${after})` : strOf(step.description),
    ];
  });
}

function thinkingSections(rec: TraceRecord, contents: ContentMap): Section[] {
  const reasoning = rec.model_invocation?.internal_reasoning;
  const inputs = Array.isArray(rec.inputs) ? rec.inputs : [];
  return [
    { kind: "rows", label: "MODEL", rows: modelRows(rec) },
    // The prompt and inputs are optional from 0.5.
    ...optionalText("PROMPT", contentText(rec.prompt, contents)),
    ...(inputs.length > 0
      ? [{ kind: "code" as const, label: "INPUTS", value: resolvedInputs(inputs, contents) }]
      : []),
    { kind: "text", label: "OUTPUT", text: contentText(rec.output_payload, contents) },
    ...(reasoning
      ? [{ kind: "text" as const, label: "REASONING", text: contentText(reasoning, contents) }]
      : []),
  ];
}

function attestingSections(rec: TraceRecord, contents: ContentMap): Section[] {
  return [
    { kind: "status", label: "DISPOSITION", status: DISPOSITION[str(rec, "disposition")] },
    {
      kind: "rows",
      label: "CHECKPOINT",
      rows: filterRows([
        ["operator", str(rec, "operator_id")],
        ["gate", str(rec, "gate_kind")],
        ["channel", str(rec, "channel")],
        ["seen digest", str(rec, "seen_digest")],
        ["seen completeness", str(rec, "seen_completeness")],
      ]),
    },
    { kind: "text", label: "REASON", text: str(rec, "reason") },
    ...optionalCode("DECISION", rec.decision),
    ...optionalCode("PATCH", rec.patch),
    ...optionalCode(
      "EFFECTS",
      rec.effects === undefined ? undefined : contentValue(rec.effects, contents),
    ),
    ...optionalCode("POLICY", rec.policy_snapshot),
  ];
}

function escalatingSections(rec: TraceRecord, contents: ContentMap): Section[] {
  const options = Array.isArray(rec.options) ? rec.options.map(strOf) : [];
  return [
    {
      kind: "rows",
      label: "ESCALATION",
      rows: filterRows([
        ["kind", str(rec, "kind")],
        ["default", str(rec, "default")],
      ]),
    },
    { kind: "text", label: "ASKED", text: contentText(rec.asked, contents) },
    ...optionalRows(
      "OPTIONS",
      options.map((option, i): [string, string] => [String(i + 1), option]),
    ),
    { kind: "status", label: "OUTCOME", status: outcomeStatus(rec) },
  ];
}

function delegatingSections(rec: TraceRecord, contents: ContentMap): Section[] {
  return [
    {
      kind: "rows",
      label: "DELEGATION",
      rows: filterRows([
        ["kind", str(rec, "kind")],
        ["delegate", str(rec, "delegate_agent_id")],
        ["child session", str(rec, "child_session_id")],
        ["awaited", str(rec, "awaited")],
      ]),
    },
    { kind: "text", label: "GOAL", text: contentText(rec.goal, contents) },
    ...optionalText("RESULT", contentText(rec.result, contents)),
    { kind: "status", label: "OUTCOME", status: outcomeStatus(rec) },
  ];
}

function memorizingSections(rec: TraceRecord, contents: ContentMap): Section[] {
  return [
    {
      kind: "rows",
      label: "MEMORY",
      rows: filterRows([
        ["scope", str(rec, "scope")],
        ["op", str(rec, "op")],
        ["approved by", str(rec, "approved_by")],
      ]),
    },
    { kind: "text", label: "TARGET", text: contentText(rec.target, contents) },
    { kind: "status", label: "OUTCOME", status: outcomeStatus(rec) },
  ];
}

function modelRows(rec: TraceRecord): [string, string][] {
  const mi = rec.model_invocation;
  if (!mi) {
    return [];
  }
  return filterRows([
    ["provider", strOf(mi.provider)],
    ["model", strOf(mi.model_name)],
    ["version", strOf(mi.model_version)],
    ["kind", strOf(mi.invocation_kind)],
    ["replay of", isContentRef(mi.replay_of) ? mi.replay_of.sha256 : strOf(mi.replay_of)],
    ["tokens in", strOf(mi.tokens_in)],
    ["tokens out", strOf(mi.tokens_out)],
    ["cache read", strOf(mi.cache_read_tokens)],
    ["cache creation", strOf(mi.cache_creation_tokens)],
    ["cost usd", strOf(mi.cost_usd)],
    ["request id", strOf(mi.request_id)],
  ]);
}

function filterRows(rows: [string, string][]): [string, string][] {
  return rows.filter(([, v]) => v && v.length > 0);
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
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
  "sequence",
  "executor",
  "record_phase",
  "outcome",
  "duration_ms",
  "error_type",
  "sources",
  "verdict",
  "written_by",
  "on_behalf_of_agent_id",
  "classification",
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

/** All dependency record ids (a pre-0.5 parent first, then upstream), de-duplicated. */
export function depIds(rec: TraceRecord): string[] {
  const ids = [
    ...(rec.parent_record_id ? [rec.parent_record_id] : []),
    ...(rec.upstream_record_id ?? []),
  ];
  return [...new Set(ids)];
}
