-- Visualiser login sessions (Reasoning Ledger v1.0, design §4.3).

-- CreateTable
CREATE TABLE "viz_sessions" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "viz_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "viz_sessions_owner_id_idx" ON "viz_sessions"("owner_id");

-- AddForeignKey
ALTER TABLE "viz_sessions" ADD CONSTRAINT "viz_sessions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
