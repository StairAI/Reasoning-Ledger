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
  "Escalating",
  "Delegating",
  "Memorizing",
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

export const Outcome = z.enum([
  "success",
  "failure",
  "denied",
  "escalated",
  "timeout",
  "cancelled",
]);
export type Outcome = z.infer<typeof Outcome>;

export const SourceDescriptor = z
  .object({
    kind: z.string().min(1),
    ref: z.string().min(1).describe("Stable reference to the source."),
    fetched_at: EpochMs.optional(),
    sha256: Sha256Hex.optional(),
  })
  .catchall(z.any())
  .describe("Where an input came from. Only kind and ref are required; other fields are open.");
export type SourceDescriptor = z.infer<typeof SourceDescriptor>;

export const DecidedBy = z
  .enum(["human", "model", "rule", "policy", "classifier", "config", "consensus"])
  .describe(
    "Who or what made the judgment. Machine approvals (config, policy, classifier) are recorded here on the record they decided, never as an Attesting record.",
  );
export type DecidedBy = z.infer<typeof DecidedBy>;

export const Verdict = z
  .object({
    conclusion: z.any().describe("The judgment itself (any JSON value)."),
    decided_by: DecidedBy,
    signals: z.array(z.record(z.string(), z.any())).optional(),
    rule_ref: z.array(z.string().min(1)).optional(),
    confidence: z.union([z.number().gte(0).lte(1), z.null()]).optional(),
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

export const Classification = z
  .object({
    source: z.enum(["instrumented", "rule", "judge", "human"]),
    mapper: z
      .string()
      .min(1)
      .describe("Name and version of the writer or mapper, e.g. 'collector@0.3'.")
      .optional(),
    confidence: z.number().gte(0).lte(1).optional(),
    alternatives: z
      .array(z.object({ behavior: BehaviorType, confidence: z.number().gte(0).lte(1) }).strict())
      .max(8)
      .optional(),
  })
  .strict()
  .describe(
    "How the record came to carry its behavior: declared by the instrumented writer, inferred by a rule, judged by a model or labelled by a person.",
  );
export type Classification = z.infer<typeof Classification>;

export const ModelInvocation = z
  .object({
    provider: z
      .union([
        z
          .string()
          .min(1)
          .describe(
            "Null is meaningful only when invocation_kind is replay or simulated; the schema does not enforce this.",
          ),
        z
          .null()
          .describe(
            "Null is meaningful only when invocation_kind is replay or simulated; the schema does not enforce this.",
          ),
      ])
      .describe(
        "Null is meaningful only when invocation_kind is replay or simulated; the schema does not enforce this.",
      ),
    model_name: z
      .union([
        z
          .string()
          .min(1)
          .describe(
            "Null is meaningful only when invocation_kind is replay or simulated; the schema does not enforce this.",
          ),
        z
          .null()
          .describe(
            "Null is meaningful only when invocation_kind is replay or simulated; the schema does not enforce this.",
          ),
      ])
      .describe(
        "Null is meaningful only when invocation_kind is replay or simulated; the schema does not enforce this.",
      ),
    invocation_kind: z
      .enum(["live", "replay", "cached", "simulated"])
      .describe(
        "live = a real call; replay = a recorded response played back; cached = served from a cache; simulated = produced without a model.",
      )
      .optional(),
    replay_of: z
      .union([UuidV4, ContentRef])
      .describe("The record or content a replay reproduces.")
      .optional(),
    tokens_in: z.number().int().gte(0).optional(),
    tokens_out: z.number().int().gte(0).optional(),
    cache_read_tokens: z.number().int().gte(0).optional(),
    cache_creation_tokens: z.number().int().gte(0).optional(),
    cost_usd: z.number().gte(0).optional(),
    temperature: z
      .number()
      .describe("Only callers that set it themselves can fill this.")
      .optional(),
    finish_reason: z.string().optional(),
    request_id: z
      .string()
      .min(1)
      .describe("The provider's request id, for reconciliation with provider logs.")
      .optional(),
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
    .describe(
      "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
    )
    .optional(),
  executor: Executor,
  record_phase: RecordPhase,
  outcome: Outcome.optional(),
  duration_ms: z
    .number()
    .int()
    .gte(0)
    .describe("On Attesting and Escalating: how long the pending item waited for a person.")
    .optional(),
  error_type: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
    )
    .optional(),
  sources: z.array(SourceDescriptor).max(64).optional(),
  verdict: Verdict.optional(),
  written_by: WrittenBy.optional(),
  on_behalf_of_agent_id: UuidV4.optional(),
  classification: Classification.optional(),
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

export const ToolMeta = z
  .object({
    name: z.string().min(1),
    call_id: z
      .string()
      .min(1)
      .describe(
        "The harness's own id for this call (OTel gen_ai.tool.call.id, ATIF tool_call_id, Claude Code tool_use_id).",
      )
      .optional(),
    tool_type: z
      .enum(["function", "mcp", "skill", "subagent", "shell", "http", "datastore"])
      .optional(),
    namespace: z
      .string()
      .min(1)
      .describe("The application's grouping of tools, e.g. an MCP server name.")
      .optional(),
    server: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
  })
  .catchall(z.any())
  .describe("Which tool was called. Only name is required; unknown keys are allowed.");
export type ToolMeta = z.infer<typeof ToolMeta>;

export const ObservingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Observing"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome.optional(),
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    trigger_source: z
      .string()
      .min(1)
      .describe(
        "Prefer a stable URI-like name, e.g. 'claude-code://user_prompt', 'arena://fixtures/<code>/window_open'.",
      ),
    trigger_type: z
      .enum(["signal_trigger", "cron_trigger", "human_trigger", "outcome_trigger", "agent_trigger"])
      .describe(
        "signal = a system event; cron = a schedule; human = a person's message or action; outcome = the result of an earlier action (settlement, test result, revert); agent = another agent or a parent harness.",
      ),
    event_ts_utc: EpochMs.optional(),
    trigger_description: z.string().min(1),
    trigger_payload_summary: z.string().max(4096),
    trigger_payload: ContentRef.optional(),
  })
  .strict();
export type ObservingRecord = z.infer<typeof ObservingRecord>;

export const ToolCallingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("ToolCalling"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome,
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    tool_meta: ToolMeta,
    description: z.string().min(1).optional(),
    effect: z
      .enum(["read", "write", "execute"])
      .describe("What the call did to the world: read only, changed state, or ran something.")
      .optional(),
    input_payload: ContentRef,
    output_payload: ContentRef,
  })
  .strict();
export type ToolCallingRecord = z.infer<typeof ToolCallingRecord>;

export const PlanningRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Planning"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome.optional(),
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    goal: z.string().min(1).describe("What the plan is for."),
    steps: z
      .array(PlanningStep)
      .describe("The ordered steps; may be empty when the plan is only a goal."),
    contingencies: z
      .array(z.string())
      .describe("What to do when a step fails or an assumption does not hold.")
      .optional(),
    revision_of: UuidV4.optional(),
  })
  .strict()
  .describe(
    "An explicit, ordered plan for the work ahead, or a revision of an earlier plan: the goal, the steps and what to do if they fail. A vague intention inside a thought is Thinking.",
  );
export type PlanningRecord = z.infer<typeof PlanningRecord>;

export const ThinkingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Thinking"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome.optional(),
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    prompt: ContentRef.optional(),
    inputs: z.array(ThinkingInput).optional(),
    output_payload: ContentRef,
  })
  .strict()
  .describe(
    "A deliberate reasoning step inside the cycle: analysis, option comparison, a decision. An explicit, ordered plan is a Planning record.",
  );
export type ThinkingRecord = z.infer<typeof ThinkingRecord>;

export const ActingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Acting"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome,
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    action_type: z
      .string()
      .regex(new RegExp("^[a-z0-9_]+(\\.[a-z0-9_]+)+$"))
      .describe(
        "Namespaced '<domain>.<verb>', e.g. prediction.submit, order.fill, answer.final, git.commit, stage.conclude.",
      ),
    target_system: z.string().min(1),
    action_summary: z.string().min(1),
    parameters: z.record(z.string(), z.any()).optional(),
    execution_id: z.string().optional(),
    execution_status: z.enum(["confirmed", "failed", "simulated", "pending", "cancelled"]),
    output_payload: ContentRef.optional(),
  })
  .strict()
  .describe(
    "The terminal commitment of a cycle: handing the result over or writing it back. Side effects along the way are ToolCalling.",
  );
export type ActingRecord = z.infer<typeof ActingRecord>;

export const ReflectingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Reflecting"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome.optional(),
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    kind: z
      .enum(["process", "evaluation", "settlement"])
      .describe(
        "process = reviewing how it worked; evaluation = judging the output against criteria; settlement = an external result coming back.",
      )
      .optional(),
    inputs: z.array(ReflectingInput),
    output_payload: ContentRef,
  })
  .strict()
  .describe(
    "The agent's evaluation of its own earlier behavior, during the cycle (record_phase concurrent: a test run read, a check) or after it (post_execution: a settlement, a retrospective).",
  );
export type ReflectingRecord = z.infer<typeof ReflectingRecord>;

export const AttestingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Attesting"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: z.literal("human"),
    record_phase: RecordPhase,
    outcome: Outcome,
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy,
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    operator_id: z.string().min(1).describe("The person who made the disposition."),
    disposition: z
      .enum(["approve", "reject", "edit", "cancel", "no_response"])
      .describe(
        "approve = accepted as proposed; edit = changed it; reject = refused; cancel = the person stopped the pending item; no_response = nobody answered (headless, or the wait ran out).",
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
    seen_digest: z
      .string()
      .min(1)
      .describe("Digest of what the person saw when deciding.")
      .optional(),
    seen_completeness: z
      .enum(["complete", "partial", "unknown"])
      .describe("Whether what the person saw covered everything the decision depended on.")
      .optional(),
    channel: z
      .enum(["interactive", "async", "headless"])
      .describe(
        "interactive = the person was present; async = handled later from a queue; headless = no person could answer.",
      )
      .optional(),
    gate_kind: z
      .string()
      .min(1)
      .describe(
        "Checkpoint type, defined by the upper-layer application; starting registry: column, plan, permission, question, deploy.",
      ),
    policy_snapshot: z
      .record(z.string(), z.any())
      .describe("Policy in force at the time, or a content reference to it.")
      .optional(),
    effects: ContentRef.optional(),
  })
  .strict()
  .describe(
    "A person's disposition of a pending item, submitted by the upper-layer application on the person's behalf. Answers an Escalating record when there is one (listed in upstream_record_id).",
  );
export type AttestingRecord = z.infer<typeof AttestingRecord>;

export const EscalatingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Escalating"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome,
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    kind: z.enum(["question", "permission", "plan", "handoff"]),
    asked: ContentRef,
    options: z.array(z.string().min(1)).max(32).optional(),
    default: z.string().describe("The option proposed as default, if any.").optional(),
  })
  .strict()
  .describe(
    "The agent hands a decision to a person: a question, a permission request, a plan to approve, or giving up and handing the work over. The person's disposition is a separate Attesting record.",
  );
export type EscalatingRecord = z.infer<typeof EscalatingRecord>;

export const DelegatingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Delegating"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome,
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    kind: z.enum(["spawn", "handoff", "message"]),
    goal: ContentRef,
    delegate_agent_id: z
      .string()
      .min(1)
      .describe("The delegate's agent id when it has one, else its type or name.")
      .optional(),
    child_session_id: z
      .string()
      .min(1)
      .describe("The session that holds the delegate's own records.")
      .optional(),
    awaited: z.boolean().describe("Whether this agent waited for the result.").optional(),
    result: ContentRef.optional(),
  })
  .strict()
  .describe(
    "The agent hands a goal to another agent: spawning a sub-agent, handing the work off, or messaging another agent. The delegate's own cycle lives in its own session.",
  );
export type DelegatingRecord = z.infer<typeof DelegatingRecord>;

export const MemorizingRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Memorizing"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome,
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    scope: z
      .enum(["session", "project", "user", "customer", "org", "global"])
      .describe("How far the written state reaches."),
    target: ContentRef,
    op: z.enum(["add", "update", "delete"]),
    approved_by: UuidV4.optional(),
  })
  .strict()
  .describe(
    "A write to state that outlives the cycle: memory, standing rules, skills, settings, a knowledge base. Reading such state is ToolCalling.",
  );
export type MemorizingRecord = z.infer<typeof MemorizingRecord>;

export const OtherRecord = z
  .object({
    schema_version: z.string().min(1),
    agent_id: UuidV4,
    session_id: z.string().min(1),
    record_id: UuidV4,
    behavior: z.literal("Other"),
    client_ts_utc: EpochMs,
    notes: z.string().max(2048).optional(),
    tags: z.array(z.string().max(64)).max(32).optional(),
    model_invocation: ModelInvocation.optional(),
    upstream_record_id: z
      .array(UuidV4)
      .max(32)
      .describe(
        "DAG dependency / trace sequence. Records this one builds on. May be empty/omitted. An Attesting record lists the Escalating record it answers here.",
      )
      .optional(),
    executor: Executor,
    record_phase: RecordPhase,
    outcome: Outcome.optional(),
    duration_ms: z
      .number()
      .int()
      .gte(0)
      .describe("On Attesting and Escalating: how long the pending item waited for a person.")
      .optional(),
    error_type: z
      .string()
      .min(1)
      .max(128)
      .describe(
        "Low-cardinality error class when outcome is failure, timeout, denied or cancelled, e.g. tool.not_found, permission.denied, http.5xx, validation.rejected, user.abort.",
      )
      .optional(),
    sources: z.array(SourceDescriptor).max(64).optional(),
    verdict: Verdict.optional(),
    written_by: WrittenBy.optional(),
    on_behalf_of_agent_id: UuidV4.optional(),
    classification: Classification.optional(),
    label: z.string().min(1),
    data: z.record(z.string(), z.any()),
    proposed_behavior: z
      .string()
      .min(1)
      .describe("The behavior the writer thinks this should be, if the taxonomy lacked it.")
      .optional(),
  })
  .strict();
export type OtherRecord = z.infer<typeof OtherRecord>;

export const Record = z.union([
  ObservingRecord,
  ToolCallingRecord,
  PlanningRecord,
  ThinkingRecord,
  ActingRecord,
  ReflectingRecord,
  AttestingRecord,
  EscalatingRecord,
  DelegatingRecord,
  MemorizingRecord,
  OtherRecord,
]);
export type Record = z.infer<typeof Record>;
