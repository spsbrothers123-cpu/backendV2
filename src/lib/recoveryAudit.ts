import type {
  AdminRecoveryEvent,
  AdminRecoveryMethod,
  AdminRecoveryOutcome,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { prisma } from "./prisma.js";

/** Works with the shared client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;

export interface RecoveryAuditInput {
  /** Set when the account is known. Null/omitted for attempts against unknown emails. */
  userId?: string | null;
  /** hashRecoverySubject(email) — the throttle key. The raw email is never stored. */
  subjectHash?: string | null;
  event: AdminRecoveryEvent;
  outcome: AdminRecoveryOutcome;
  method?: AdminRecoveryMethod | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

// Defence in depth for the one rule that matters: recovery secrets must
// never reach the audit table. Any metadata key that looks like it could
// carry one is a programmer error and is refused outright.
const FORBIDDEN_METADATA_KEY = /(pass(word)?|token|secret|pepper|hash|^code$|raw)/i;

export function assertSafeAuditMetadata(
  metadata: Record<string, unknown> | undefined
): asserts metadata is Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEY.test(key)) {
      throw new Error(`Refusing to write recovery audit metadata key "${key}" (could carry a secret).`);
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      throw new Error(`Recovery audit metadata "${key}" must be a primitive value.`);
    }
  }
}

/**
 * Appends one row to admin_recovery_audit. This table is also the durable
 * throttle ledger (see recoveryThrottle.ts): a failed code verification
 * MUST be recorded as { event: CODE_VERIFICATION, outcome: FAILURE } with
 * the request's subjectHash and ip, or it will not count toward throttling.
 */
export async function recordRecoveryAudit(input: RecoveryAuditInput, db: Db = prisma): Promise<void> {
  assertSafeAuditMetadata(input.metadata);
  await db.adminRecoveryAudit.create({
    data: {
      userId: input.userId ?? null,
      subjectHash: input.subjectHash ?? null,
      event: input.event,
      outcome: input.outcome,
      method: input.method ?? null,
      ip: input.ip?.slice(0, 64) ?? null,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
      metadata: input.metadata ?? undefined,
    },
  });
}
