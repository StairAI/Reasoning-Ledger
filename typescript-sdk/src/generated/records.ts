// Code generated from schema/records.schema.json — do not edit manually.

import { z } from "zod";

export const BehaviorType = z.enum(["Observing","ToolCalling","Planning","Thinking","Acting","Reflecting","Other"]);
export type BehaviorType = z.infer<typeof BehaviorType>;

export const UuidV4 = z.string().uuid();
export type UuidV4 = z.infer<typeof UuidV4>;

export const EpochMs = z.number().int().gte(0);
export type EpochMs = z.infer<typeof EpochMs>;

export const ModelInvocation = z.object({ "provider": z.string().min(1), "model_name": z.string().min(1), "model_version": z.string().optional(), "tokens_in": z.number().int().gte(0).optional(), "tokens_out": z.number().int().gte(0).optional(), "cost_usd": z.number().gte(0).optional(), "temperature": z.number().optional(), "finish_reason": z.string().optional() }).strict();
export type ModelInvocation = z.infer<typeof ModelInvocation>;

export const BaseRecord = z.object({ "schema_version": z.string().min(1), "agent_id": UuidV4, "session_id": z.string().min(1), "record_id": UuidV4, "behavior": BehaviorType, "client_ts_utc": EpochMs, "notes": z.string().max(2048).optional(), "tags": z.array(z.string().max(64)).max(32).optional(), "model_invocation": ModelInvocation.optional(), "upstream_record_id": z.array(UuidV4).max(32).describe("DAG dependency / trace sequence. Records this one builds on. May be empty/omitted.").optional(), "parent_record_id": UuidV4.optional() });
export type BaseRecord = z.infer<typeof BaseRecord>;

export const ThinkingInput = z.object({ "input_record_id": UuidV4.optional(), "input_payload": z.string() }).strict();
export type ThinkingInput = z.infer<typeof ThinkingInput>;

export const ReflectingInput = z.object({ "input_record_id": UuidV4.optional(), "input_payload": z.string() }).strict();
export type ReflectingInput = z.infer<typeof ReflectingInput>;

export const PlanningStep = z.object({ "index": z.number().int().gte(0), "description": z.string().min(1), "depends_on": z.array(z.number().int().gte(0)).optional() }).strict();
export type PlanningStep = z.infer<typeof PlanningStep>;

export const ObservingRecord = z.intersection(BaseRecord, z.object({ "behavior": z.literal("Observing"), "trigger_source": z.string().min(1), "trigger_type": z.enum(["signal_trigger","cron_trigger"]), "external_trigger_id": z.string().optional(), "event_ts_utc": EpochMs.optional(), "trigger_description": z.string().min(1), "trigger_payload_summary": z.string().max(4096) }));
export type ObservingRecord = z.infer<typeof ObservingRecord>;

export const ToolCallingRecord = z.intersection(BaseRecord, z.object({ "behavior": z.literal("ToolCalling"), "tool_meta": z.record(z.string(), z.any()), "description": z.string().min(1), "input_payload": z.any(), "output_payload": z.any(), "success": z.boolean() }));
export type ToolCallingRecord = z.infer<typeof ToolCallingRecord>;

export const PlanningRecord = z.intersection(BaseRecord, z.object({ "behavior": z.literal("Planning"), "goal": z.string().min(1), "steps": z.array(PlanningStep), "contingencies": z.array(z.string()).optional() }));
export type PlanningRecord = z.infer<typeof PlanningRecord>;

export const ThinkingRecord = z.intersection(BaseRecord, z.object({ "behavior": z.literal("Thinking"), "prompt": z.string().min(1), "inputs": z.array(ThinkingInput), "output_payload": z.string().min(1) }));
export type ThinkingRecord = z.infer<typeof ThinkingRecord>;

export const ActingRecord = z.intersection(BaseRecord, z.object({ "behavior": z.literal("Acting"), "action_type": z.string().min(1), "target_system": z.string().min(1), "action_summary": z.string().min(1), "parameters": z.record(z.string(), z.any()), "dry_run": z.boolean(), "execution_id": z.string().optional(), "execution_status": z.enum(["confirmed","failed","simulated","pending"]) }).and(z.any()));
export type ActingRecord = z.infer<typeof ActingRecord>;

export const ReflectingRecord = z.intersection(BaseRecord, z.object({ "behavior": z.literal("Reflecting"), "inputs": z.array(ReflectingInput), "output_payload": z.string().min(1) }));
export type ReflectingRecord = z.infer<typeof ReflectingRecord>;

export const OtherRecord = z.intersection(BaseRecord, z.object({ "behavior": z.literal("Other"), "label": z.string().min(1), "data": z.record(z.string(), z.any()) }));
export type OtherRecord = z.infer<typeof OtherRecord>;

export const Record = z.discriminatedUnion("behavior", [ObservingRecord, ToolCallingRecord, PlanningRecord, ThinkingRecord, ActingRecord, ReflectingRecord, OtherRecord]);
export type Record = z.infer<typeof Record>;
