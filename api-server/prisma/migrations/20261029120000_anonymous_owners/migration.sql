-- Anonymous owners (2.0.2): an owner registers without an e-mail and may claim one later.
-- The unique index stays; Postgres lets any number of rows have no e-mail.

-- AlterTable
ALTER TABLE "owners" ALTER COLUMN "email" DROP NOT NULL;
