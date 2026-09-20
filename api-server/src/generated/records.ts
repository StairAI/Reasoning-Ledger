// Code generated from schema/records.schema.json — do not edit manually.

import { z } from "zod";

export const BehaviorType = z.enum([
  "Observing",
  "ToolCalling",
  "Planning",
  "Thinking",
  "Acting",
  "Reflecting",
  "Attesting",
  "Other",
]);
export type BehaviorType = z.infer<typeof BehaviorType>;

export const UuidV4 = z.string().uuid();
export type UuidV4 = z.infer<typeof UuidV4>;

export const EpochMs = z.number().int().gte(0);
export type EpochMs = z.infer<typeof EpochMs>;

export const Sha256Hex = z.string().regex(new RegExp("^[0-9a-f]{64}$"));
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const ContentRef = z
  .object({ sha256: Sha256Hex, bytes: z.number().int().gte(0), media_type: z.string().min(1) })
  .strict()
  .describe(
    "Reference to raw content held in the content library. Raw text never goes into a record: upload the bytes first, then reference them.",
  );
export type ContentRef = z.infer<typeof ContentRef>;

export const Executor = z
  .enum(["ai", "det", "human"])
  .describe("Who performed the step: a model (ai), deterministic code (det) or a person (human).");
export type Executor = z.infer<typeof Executor>;

export const RecordPhase = z
  .enum(["pre_execution", "concurrent", "post_execution"])
  .describe("When the record was written relative to the action it describes.");
export type RecordPhase = z.infer<typeof RecordPhase>;

export const Outcome = z.enum(["success", "failure", "denied", "escalated", "timeout"]);
export type Outcome = z.infer<typeof Outcome>;

export const SourceDescriptor = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1).describe("Stable reference to the source."),
    fetched_at: EpochMs.optional(),
    sha256: Sha256Hex.optional(),
    record_id: UuidV4.optional(),
  })
  .catchall(z.any())
  .describe("Where an input came from. Only kind and ref are required; other fields are open.");
export type SourceDescriptor = z.infer<typeof SourceDescriptor>;

export const Verdict = z
  .object({
    conclusion: z.any().describe("The judgment itself (any JSON value)."),
    decided_by: z.string().min(1),
    signals: z.array(z.record(z.string(), z.any())).optional(),
    rule_ref: z.array(z.string().min(1)).optional(),
    confidence: z.union([z.number().gte(0).lte(1), z.null()]).optional(),
    sources: z.array(SourceDescriptor).optional(),
    counterfactual: z.string().optional(),
    dissent: z.array(z.record(z.string(), z.any())).optional(),
  })
  .catchall(z.any())
  .describe(
    "Basis of a judgment. Only conclusion and decided_by are required; other fields are open.",
  );
export type Verdict = z.infer<typeof Verdict>;

export const WrittenBy = z
  .object({ component: z.string().min(1), credential: z.string().min(1) })
  .strict()
  .describe(
    "Declared by the submitter: which component wrote the record, with which credential. A record, not a permission.",
  );
export type WrittenBy = z.infer<typeof WrittenBy>;

export const ModelInvocation = z
  .object({
    provider: z.string().min(1),
    model_name: z.string().min(1),
    model_version: z.string().optional(),
    tokens_in: z.number().int().gte(0).optional(),
    tokens_out: z.number().int().gte(0).optional(),
    cost_usd: z.number().gte(0).optional(),
    temperature: z.number().optional(),
    finish_reason: z.string().optional(),
    internal_reasoning: ContentRef.optional(),
  })
  .strict();
export type ModelInvocation = z.infer<typeof ModelInvocation>;

export const BaseRecord = z.object({
  schema_version: z.string().min(1),
  agent_id: UuidV4,
  session_id: z.string().min(1),
  record_id: UuidV4,
  behavior: BehaviorType,
  client_ts_utc: EpochMs,
  notes: z.string().max(2048).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  model_invocation: ModelInvocation.optional(),
  upstream_record_id: z
    .array(UuidV4)
    .max(32)
    .describe("DAG dependency / trace sequence. Records this one builds on. May be empty/omitted.")
    .optional(),
  parent_record_id: UuidV4.optional(),
  executor: Executor,
  record_phase: RecordPhase,
  outcome: Outcome.optional(),
  duration_ms: z.number().int().gte(0).optional(),
  sources: z.array(SourceDescriptor).max(64).optional(),
  verdict: Verdict.optional(),
});
export type BaseRecord = z.infer<typeof BaseRecord>;

export const ThinkingInput = z
  .object({ input_record_id: UuidV4.optional(), input_payload: ContentRef })
  .strict();
export type ThinkingInput = z.infer<typeof ThinkingInput>;

export const ReflectingInput = z
  .object({ input_record_id: UuidV4.optional(), input_payload: ContentRef })
  .strict();
export type ReflectingInput = z.infer<typeof ReflectingInput>;

export const PlanningStep = z
  .object({
    index: z.number().int().gte(0),
    description: z.string().min(1),
    depends_on: z.array(z.number().int().gte(0)).optional(),
  })
  .strict();
export type PlanningStep = z.infer<typeof PlanningStep>;

export const ObservingRecord = z.intersection(
  BaseRecord,
  z.object({
    behavior: z.literal("Observing"),
    trigger_source: z.string().min(1),
    trigger_type: z.enum(["signal_trigger", "cron_trigger"]),
    external_trigger_id: z.string().optional(),
    event_ts_utc: EpochMs.optional(),
    trigger_description: z.string().min(1),
    trigger_payload_summary: z.string().max(4096),
  }),
);
export type ObservingRecord = z.infer<typeof ObservingRecord>;

export const ToolCallingRecord = z.intersection(
  BaseRecord,
  z.object({
    behavior: z.literal("ToolCalling"),
    tool_meta: z.record(z.string(), z.any()),
    description: z.string().min(1),
    input_payload: ContentRef,
    output_payload: ContentRef,
    outcome: Outcome,
  }),
);
export type ToolCallingRecord = z.infer<typeof ToolCallingRecord>;

export const PlanningRecord = z.intersection(
  BaseRecord,
  z.object({
    behavior: z.literal("Planning"),
    goal: z.string().min(1),
    steps: z.array(PlanningStep),
    contingencies: z.array(z.string()).optional(),
  }),
);
export type PlanningRecord = z.infer<typeof PlanningRecord>;

export const ThinkingRecord = z.intersection(
  BaseRecord,
  z.object({
    behavior: z.literal("Thinking"),
    prompt: ContentRef,
    inputs: z.array(ThinkingInput),
    output_payload: ContentRef,
  }),
);
export type ThinkingRecord = z.infer<typeof ThinkingRecord>;

export const ActingRecord = z.intersection(
  BaseRecord,
  z.object({
    behavior: z.literal("Acting"),
    action_type: z.string().min(1),
    target_system: z.string().min(1),
    action_summary: z.string().min(1),
    parameters: z.record(z.string(), z.any()),
    dry_run: z.boolean(),
    execution_id: z.string().optional(),
    execution_status: z.enum(["confirmed", "failed", "simulated", "pending"]),
  }),
);
export type ActingRecord = z.infer<typeof ActingRecord>;

export const ReflectingRecord = z.intersection(
  BaseRecord,
  z.object({
    behavior: z.literal("Reflecting"),
    inputs: z.array(ReflectingInput),
    output_payload: ContentRef,
  }),
);
export type ReflectingRecord = z.infer<typeof ReflectingRecord>;

export const AttestingRecord = z
  .intersection(
    BaseRecord,
    z.object({
      behavior: z.literal("Attesting"),
      executor: z.literal("human"),
      operator_id: z.string().min(1).describe("The person who made the disposition."),
      disposition: z
        .enum(["approve", "reject", "edit"])
        .describe(
          "For value-choosing decisions: approve = accepted the default suggestion, edit = changed it.",
        ),
      decision: z
        .any()
        .describe(
          "Structured decision content: the value the person chose or entered. Shape declared by the upper-layer application.",
        )
        .optional(),
      reason: z.string().min(1).describe("Required when disposition is reject.").optional(),
      patch: z
        .record(z.string(), z.any())
        .describe("Changes to the original parameters when disposition is edit.")
        .optional(),
      evidence_refs: z
        .array(z.union([UuidV4, ContentRef]))
        .max(64)
        .describe("Record ids or content references the disposition relied on.")
        .optional(),
      seen_digest: z
        .string()
        .min(1)
        .describe("Digest of what the person saw when deciding.")
        .optional(),
      gate_kind: z
        .string()
        .min(1)
        .describe("Checkpoint type, defined by the upper-layer application."),
      policy_snapshot: z
        .record(z.string(), z.any())
        .describe("Policy in force at the time, or a content reference to it.")
        .optional(),
      effects: ContentRef.optional(),
      written_by: WrittenBy,
    }),
  )
  .describe(
    "A person's disposition of a pending action, submitted by the upper-layer application on the person's behalf.",
  );
export type AttestingRecord = z.infer<typeof AttestingRecord>;

export const OtherRecord = z.intersection(
  BaseRecord,
  z.object({
    behavior: z.literal("Other"),
    label: z.string().min(1),
    data: z.record(z.string(), z.any()),
  }),
);
export type OtherRecord = z.infer<typeof OtherRecord>;

export const Record = z.union([
  ObservingRecord,
  ToolCallingRecord,
  PlanningRecord,
  ThinkingRecord,
  ActingRecord,
  ReflectingRecord,
  AttestingRecord,
  OtherRecord,
]);
export type Record = z.infer<typeof Record>;
