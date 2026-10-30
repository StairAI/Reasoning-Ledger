-- View grants (2.1.0): a time-limited authorization to read some of an owner's sessions in the trace viewer.

-- CreateTable
CREATE TABLE "view_grants" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "session_ids" TEXT[],
    "keys" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "view_grants_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "viz_sessions" ADD COLUMN "grant_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "view_grants_token_hash_key" ON "view_grants"("token_hash");

-- CreateIndex
CREATE INDEX "view_grants_owner_id_idx" ON "view_grants"("owner_id");

-- CreateIndex
CREATE INDEX "viz_sessions_grant_id_idx" ON "viz_sessions"("grant_id");

-- AddForeignKey
ALTER TABLE "viz_sessions" ADD CONSTRAINT "viz_sessions_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "view_grants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "view_grants" ADD CONSTRAINT "view_grants_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
