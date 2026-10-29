-- Schema 0.5: three new behaviors (Escalating, Delegating, Memorizing) and the
-- outcome value 'cancelled'. Planning stays in the enum for the 0.4 records that
-- carry it; the schema no longer accepts it on writes. New base fields
-- (error_type, written_by, on_behalf_of_agent_id, classification) live in the
-- JSONB payload column like sources and verdict do: no new columns.

-- AlterEnum
ALTER TYPE "BehaviorType" ADD VALUE 'Escalating';
ALTER TYPE "BehaviorType" ADD VALUE 'Delegating';
ALTER TYPE "BehaviorType" ADD VALUE 'Memorizing';
ALTER TYPE "Outcome" ADD VALUE 'cancelled';
