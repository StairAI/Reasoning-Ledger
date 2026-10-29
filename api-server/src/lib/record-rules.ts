/**
 * Cross-field rules from schema/records.schema.json that the generated zod
 * schemas do not enforce (JSON Schema `if`/`then`). Returns one message per
 * broken rule; an empty list means the record passes.
 */
export function recordRuleProblems(record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (
    record.behavior === "Acting" &&
    record.target_system === "public-chain" &&
    record.execution_status === "confirmed" &&
    !record.execution_id
  ) {
    problems.push(
      "execution_id is required when target_system is 'public-chain' and execution_status is 'confirmed'",
    );
  }
  if (record.behavior === "Attesting" && record.disposition === "reject" && !record.reason) {
    problems.push("reason is required when disposition is 'reject'");
  }
  if (
    record.behavior === "Attesting" &&
    record.disposition === "no_response" &&
    record.outcome !== "timeout"
  ) {
    problems.push("outcome must be 'timeout' when disposition is 'no_response'");
  }
  if (
    record.behavior === "Attesting" &&
    record.disposition === "cancel" &&
    record.outcome !== "cancelled"
  ) {
    problems.push("outcome must be 'cancelled' when disposition is 'cancel'");
  }
  return problems;
}
