-- CreateEnum
CREATE TYPE "WalletMode" AS ENUM ('custodial', 'byow');

-- CreateEnum
CREATE TYPE "BehaviorType" AS ENUM ('Observing', 'ToolCalling', 'Planning', 'Thinking', 'Acting', 'Reflecting', 'Other');

-- CreateTable
CREATE TABLE "owners" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "wallet_mode" "WalletMode" NOT NULL,
    "owner_wallet_address" TEXT NOT NULL,
    "display_name" TEXT,
    "website" TEXT,
    "contact_email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "agent_wallet_address" TEXT NOT NULL,
    "description" TEXT,
    "website" TEXT,
    "tags" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trace_records" (
    "record_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "behavior" "BehaviorType" NOT NULL,
    "client_ts_utc" BIGINT NOT NULL,
    "server_ts_utc" BIGINT NOT NULL,
    "notes" TEXT,
    "tags" TEXT[],
    "model_invocation" JSONB,
    "upstream_record_id" TEXT[],
    "parent_record_id" TEXT,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trace_records_pkey" PRIMARY KEY ("record_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "owners_email_key" ON "owners"("email");

-- CreateIndex
CREATE UNIQUE INDEX "owners_api_key_hash_key" ON "owners"("api_key_hash");

-- CreateIndex
CREATE INDEX "agents_owner_id_idx" ON "agents"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_owner_id_name_key" ON "agents"("owner_id", "name");

-- CreateIndex
CREATE INDEX "trace_records_agent_id_session_id_idx" ON "trace_records"("agent_id", "session_id");

-- CreateIndex
CREATE INDEX "trace_records_agent_id_server_ts_utc_idx" ON "trace_records"("agent_id", "server_ts_utc" DESC);

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_records" ADD CONSTRAINT "trace_records_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
