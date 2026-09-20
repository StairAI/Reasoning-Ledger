import { ORPCError } from "@orpc/server";
import { prisma } from "#/lib/prisma";

export interface ContentRef {
  sha256: string;
  bytes: number;
  media_type: string;
}

function isContentRef(value: unknown): value is ContentRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ContentRef).sha256 === "string" &&
    typeof (value as ContentRef).bytes === "number"
  );
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Every content reference a record carries, at the positions schema 0.4 defines. */
export function contentRefsOf(record: Record<string, unknown>): ContentRef[] {
  const candidates: unknown[] = [field(record.model_invocation, "internal_reasoning")];
  switch (record.behavior) {
    case "ToolCalling": {
      candidates.push(record.input_payload, record.output_payload);
      break;
    }
    case "Thinking": {
      candidates.push(record.prompt, record.output_payload);
      candidates.push(...items(record.inputs).map((input) => field(input, "input_payload")));
      break;
    }
    case "Reflecting": {
      candidates.push(record.output_payload);
      candidates.push(...items(record.inputs).map((input) => field(input, "input_payload")));
      break;
    }
    case "Attesting": {
      candidates.push(record.effects, ...items(record.evidence_refs));
      break;
    }
    default: {
      break;
    }
  }
  return candidates.filter(isContentRef);
}

/**
 * Referenced content must already be in this owner's namespace, not deleted,
 * and the size in the reference must match what was stored.
 */
export async function assertContentPresent(ownerId: string, refs: ContentRef[]): Promise<void> {
  if (refs.length === 0) {
    return;
  }
  const rows = await prisma.contentObject.findMany({
    select: { bytes: true, deleted_at: true, sha256: true },
    where: { owner_id: ownerId, sha256: { in: [...new Set(refs.map((ref) => ref.sha256))] } },
  });
  const byHash = new Map(rows.map((row) => [row.sha256, row]));
  for (const ref of refs) {
    const row = byHash.get(ref.sha256);
    if (!row) {
      throw new ORPCError("BAD_REQUEST", {
        message: `content ${ref.sha256} has not been uploaded by this owner; upload it before submitting the record`,
      });
    }
    if (row.deleted_at) {
      throw new ORPCError("BAD_REQUEST", { message: `content ${ref.sha256} was deleted` });
    }
    if (Number(row.bytes) !== ref.bytes) {
      throw new ORPCError("BAD_REQUEST", {
        message: `content ${ref.sha256} is ${row.bytes} bytes, but the reference says ${ref.bytes}`,
      });
    }
  }
}
