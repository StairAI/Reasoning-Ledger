-- Content library (Reasoning Ledger v1.0, design §3): per-owner content objects
-- and an append-only deletion log.

-- CreateTable
CREATE TABLE "content_objects" (
    "owner_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "media_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "content_objects_pkey" PRIMARY KEY ("owner_id","sha256")
);

-- CreateTable
CREATE TABLE "content_deletions" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_deletions_owner_id_sha256_idx" ON "content_deletions"("owner_id", "sha256");

-- AddForeignKey
ALTER TABLE "content_objects" ADD CONSTRAINT "content_objects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
