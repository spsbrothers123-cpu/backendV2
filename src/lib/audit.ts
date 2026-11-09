import type { AuditAction, Role } from "@prisma/client";
import { prisma } from "./prisma.js";

interface AuditInput {
  action: AuditAction;
  actorId?: string | null;
  actorRole?: Role | null;
  shopId?: string | null;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

// Never pass passwords, OTP values/hashes, or tokens in `metadata` —
// this is the one place every security/account event is recorded, so
// keeping it clean here keeps it clean everywhere.
export async function recordAudit(input: AuditInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: input.action,
      actorId: input.actorId ?? null,
      actorRole: input.actorRole ?? null,
      shopId: input.shopId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: input.metadata as never,
    },
  });
}
