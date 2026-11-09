import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { Errors } from "./errors.js";
import {
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  requirePepper,
} from "./recoveryCrypto.js";
import { env } from "../config/env.js";
import { recordRecoveryAudit, type Db } from "./recoveryAudit.js";

/**
 * Admin emergency recovery codes — database operations.
 * Pure crypto lives in recoveryCrypto.ts. Nothing here is wired to a route
 * yet (that is Phase 2/3); these are the building blocks.
 */

export const RECOVERY_CODE_COUNT = 8;

export interface GeneratedRecoveryCodes {
  setId: string;
  /** The ONLY time raw codes exist server-side. Return to the caller once; never log or persist. */
  codes: string[];
  /** True when this replaced an existing set (i.e. a regeneration). */
  regenerated: boolean;
}

export interface RecoveryRequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Creates a fresh set of RECOVERY_CODE_COUNT independent codes for an
 * Admin and revokes every previously active code, all in ONE transaction.
 *
 * Concurrency: the transaction first takes a row lock on the user
 * (SELECT … FOR UPDATE). Two simultaneous generate/regenerate calls for the
 * same Admin are therefore serialized, so the account can never end up with
 * two active sets (16 usable codes) — the second call revokes the first's
 * codes and leaves exactly one active set of 8.
 *
 * Defence in depth: only an ACTIVE ADMIN can ever receive codes; the check
 * happens on the locked row inside the transaction.
 *
 * Callers (Phase 2 routes) are responsible for requiring recent
 * authentication before invoking this.
 */
export async function generateRecoveryCodeSet(
  userId: string,
  ctx: RecoveryRequestContext = {}
): Promise<GeneratedRecoveryCodes> {
  // Fail closed BEFORE doing any work if the pepper is not configured.
  const pepper = requirePepper(env.RECOVERY_CODE_PEPPER);

  const setId = randomUUID();
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
  const rows = codes.map((code) => ({
    id: randomUUID(),
    userId,
    setId,
    // normalizeRecoveryCode cannot return null for a freshly generated code.
    codeHash: hashRecoveryCode(userId, normalizeRecoveryCode(code)!, pepper),
  }));

  const regenerated = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ role: string; status: string }>>`
      SELECT "role"::text AS role, "status"::text AS status
      FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
    const user = locked[0];
    if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE") {
      throw Errors.forbidden("Recovery codes are only available to active Admin accounts.", "ROLE_NOT_ALLOWED");
    }

    const hadPrevious = (await tx.adminRecoveryCode.count({ where: { userId } })) > 0;

    await tx.adminRecoveryCode.updateMany({
      where: { userId, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await tx.adminRecoveryCode.createMany({ data: rows });

    await recordRecoveryAudit(
      {
        userId,
        event: hadPrevious ? "CODES_REGENERATED" : "CODES_GENERATED",
        outcome: "SUCCESS",
        method: "RECOVERY_CODE",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { setId, count: RECOVERY_CODE_COUNT },
      },
      tx
    );

    return hadPrevious;
  });

  return { setId, codes, regenerated };
}

/**
 * Atomically consumes one recovery code for `userId`.
 *
 * Returns true for exactly one caller: the single conditional
 *   UPDATE … SET usedAt = now WHERE userId = ? AND codeHash = ?
 *                              AND usedAt IS NULL AND revokedAt IS NULL
 * can only match the row once, so concurrent redemptions of the same code
 * cannot both succeed (the loser's UPDATE sees usedAt already set and
 * affects 0 rows). Returns false for: malformed input, unknown code, a
 * code belonging to another account (the hash is bound to userId), an
 * already-used code, and a revoked (regenerated-away) code — the caller
 * must not distinguish these to the client.
 *
 * `db` may be a transaction client so Phase 3 can consume the code, issue
 * the recovery grant and write audit rows atomically.
 *
 * Throttling is the caller's job (see recoveryThrottle.ts) and must run
 * BEFORE this is called.
 */
export async function consumeRecoveryCode(userId: string, rawCode: unknown, db: Db = prisma): Promise<boolean> {
  const normalized = normalizeRecoveryCode(rawCode);
  if (!normalized) return false;

  const result = await db.adminRecoveryCode.updateMany({
    where: {
      userId,
      codeHash: hashRecoveryCode(userId, normalized),
      usedAt: null,
      revokedAt: null,
    },
    data: { usedAt: new Date() },
  });
  return result.count === 1;
}

/** Number of still-usable codes (for the Security Settings status display and the "no recovery method" check). */
export async function countActiveRecoveryCodes(userId: string, db: Db = prisma): Promise<number> {
  return db.adminRecoveryCode.count({ where: { userId, usedAt: null, revokedAt: null } });
}
