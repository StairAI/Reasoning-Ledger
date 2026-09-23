-- Schema 0.4 (Reasoning Ledger v1.0): Attesting behavior, executor / record_phase /
-- outcome / duration_ms columns, server-assigned sequence, optional wallet fields.
-- Runs on empty databases and on databases holding 0.1–0.3 records.

-- "1.0" was the label SDK 0.1.0 stamped on what is now the 0.2 format.
UPDATE "trace_records" SET "schema_version" = '0.2' WHERE "schema_version" = '1.0';

-- AlterEnum
ALTER TYPE "BehaviorType" ADD VALUE 'Attesting';

-- CreateEnum
CREATE TYPE "Executor" AS ENUM ('ai', 'det', 'human');
CREATE TYPE "RecordPhase" AS ENUM ('pre_execution', 'concurrent', 'post_execution');
CREATE TYPE "Outcome" AS ENUM ('success', 'failure', 'denied', 'escalated', 'timeout');

-- AlterTable
ALTER TABLE "trace_records"
  ADD COLUMN "executor" "Executor",
  ADD COLUMN "record_phase" "RecordPhase",
  ADD COLUMN "outcome" "Outcome",
  ADD COLUMN "duration_ms" INTEGER,
  ADD COLUMN "sequence" BIGINT;

-- Backfill sequence in (server_ts_utc, record_id) order, then hand the column to a sequence.
UPDATE "trace_records" AS t
SET "sequence" = o.rn
FROM (
  SELECT "record_id", row_number() OVER (ORDER BY "server_ts_utc", "record_id") AS rn
  FROM "trace_records"
) AS o
WHERE t."record_id" = o."record_id";

CREATE SEQUENCE "trace_records_sequence_seq" AS BIGINT OWNED BY "trace_records"."sequence";
SELECT setval('"trace_records_sequence_seq"', COALESCE((SELECT MAX("sequence") FROM "trace_records"), 0) + 1, false);
ALTER TABLE "trace_records"
  ALTER COLUMN "sequence" SET DEFAULT nextval('"trace_records_sequence_seq"'),
  ALTER COLUMN "sequence" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "trace_records_sequence_key" ON "trace_records"("sequence");
CREATE INDEX "trace_records_agent_id_sequence_idx" ON "trace_records"("agent_id", "sequence");

-- Records from schema 0.4 on must say who performed the step and when.
ALTER TABLE "trace_records" ADD CONSTRAINT "trace_records_executor_phase_check"
  CHECK ("schema_version" IN ('0.1', '0.2', '0.3') OR ("executor" IS NOT NULL AND "record_phase" IS NOT NULL));

-- Wallet fields are optional: no chain anchoring in v1.0.
ALTER TABLE "owners" ALTER COLUMN "owner_wallet_address" DROP NOT NULL;
ALTER TABLE "agents" ALTER COLUMN "agent_wallet_address" DROP NOT NULL;
