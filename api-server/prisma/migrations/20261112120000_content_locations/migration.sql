-- Content locations (2.4.0).
--
-- content_objects.location records where an object's bytes are: "fs", a file
-- under CONTENT_DIR, where all content was kept until now (so every existing
-- row gets it); "db", a row of content_blobs; or "s3", an object in an
-- S3-compatible bucket. content_blobs holds the bytes of the objects kept in
-- the database; the runtime account may add rows but never change or delete
-- them (prisma/grants.sql).
--
-- Nothing here rewrites content_objects or holds a lock for long: a column with
-- a constant default is added without touching the rows, and the CHECK is
-- added NOT VALID and validated separately, under a lock that lets reads and
-- writes go on.

-- AlterTable
ALTER TABLE "content_objects" ADD COLUMN "location" TEXT NOT NULL DEFAULT 'fs';

ALTER TABLE "content_objects"
  ADD CONSTRAINT "content_objects_location_check" CHECK ("location" IN ('fs', 'db', 's3')) NOT VALID;

ALTER TABLE "content_objects" VALIDATE CONSTRAINT "content_objects_location_check";

-- CreateTable
CREATE TABLE "content_blobs" (
    "owner_id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_blobs_pkey" PRIMARY KEY ("owner_id","sha256")
);

-- AddForeignKey
ALTER TABLE "content_blobs" ADD CONSTRAINT "content_blobs_owner_id_sha256_fkey" FOREIGN KEY ("owner_id", "sha256") REFERENCES "content_objects"("owner_id", "sha256") ON DELETE CASCADE ON UPDATE CASCADE;
