-- Content encryption and invite codes (2.0.0-rc.2).
--
-- content_keys: wrapped data keys, one per session, registered by the writer
-- before it references encrypted content. The server cannot unwrap them.
-- invites: registration codes for RL_REGISTRATION=invite. owners.invite_code
-- keeps the code an owner registered with.

-- AlterTable
ALTER TABLE "owners" ADD COLUMN "invite_code" TEXT;

-- CreateTable
CREATE TABLE "content_keys" (
    "owner_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "session_id" TEXT,
    "wrap_alg" TEXT NOT NULL,
    "master_key_id" TEXT NOT NULL,
    "wrapped_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_keys_pkey" PRIMARY KEY ("owner_id","key_id")
);

-- CreateTable
CREATE TABLE "invites" (
    "code" TEXT NOT NULL,
    "note" TEXT,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "content_keys_owner_id_session_id_idx" ON "content_keys"("owner_id", "session_id");

-- AddForeignKey
ALTER TABLE "content_keys" ADD CONSTRAINT "content_keys_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
