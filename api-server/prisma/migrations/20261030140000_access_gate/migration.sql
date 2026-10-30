-- Access gate (2.1.0): a handle per owner, the namespace every resource behind the gate uses, and grants that
-- say which resources an owner may get tokens for. See lib/access.ts.

-- AlterTable
ALTER TABLE "owners" ADD COLUMN     "handle" TEXT;

-- CreateTable
CREATE TABLE "access_grants" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "scopes" TEXT[],
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "access_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_grants_owner_id_resource_idx" ON "access_grants"("owner_id", "resource");

-- CreateIndex
CREATE UNIQUE INDEX "owners_handle_key" ON "owners"("handle");

-- AddForeignKey
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

