-- A viewer session may belong to the instance administrator, who is not an owner.
ALTER TABLE "viz_sessions" ALTER COLUMN "owner_id" DROP NOT NULL;
