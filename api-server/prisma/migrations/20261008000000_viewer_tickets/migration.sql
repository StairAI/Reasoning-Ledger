-- One-time sign-in tickets for the trace viewer. Only the SHA-256 of a ticket
-- is stored; the runtime account's privileges come from prisma/grants.sql.

-- CreateTable
CREATE TABLE "viewer_tickets" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "next" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "viewer_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "viewer_tickets_owner_id_idx" ON "viewer_tickets"("owner_id");

-- AddForeignKey
ALTER TABLE "viewer_tickets" ADD CONSTRAINT "viewer_tickets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
