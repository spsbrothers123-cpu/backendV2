import type { AdminRecoveryMethod } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "./prisma.js";
import {
  generateGrantToken,
  hashGrantToken,
  hashUserAgent,
  isWellFormedGrantToken,
} from "./recoveryCrypto.js";
import type { Db } from "./recoveryAudit.js";

/**
 * Recovery grant = the short-lived, single-purpose authorization issued
 * AFTER a recovery credential (code, later a passkey) has been verified and
 * BEFORE the new password is set. It authorizes exactly one thing: setting
 * a new password for the one account it was issued to.
 *
 * It is an opaque random token, not a JWT, on purpose: a stateless token
 * cannot be made strictly single-use under concurrency. Here the database
 * row is the source of truth and is consumed atomically.
 */

export interface IssuedRecoveryGrant {
  /** Return to the client once; only its SHA-256 is stored. */
  token: string;
  expiresAt: Date;
}

export interface ConsumedRecoveryGrant {
  userId: string;
  method: AdminRecoveryMethod;
}

export async function issueRecoveryGrant(
  input: { userId: string; method: AdminRecoveryMethod; userAgent?: string | null },
  db: Db = prisma
): Promise<IssuedRecoveryGrant> {
  const token = generateGrantToken();
  const expiresAt = new Date(Date.now() + env.RECOVERY_GRANT_EXPIRY_MINUTES * 60_000);

  await db.adminRecoveryGrant.create({
    data: {
      userId: input.userId,
      method: input.method,
      tokenHash: hashGrantToken(token),
      userAgentHash: hashUserAgent(input.userAgent),
      expiresAt,
    },
  });

  return { token, expiresAt };
}

/**
 * Atomically redeems a grant. Succeeds for exactly one caller, and only if
 * the grant is unconsumed, unexpired, and presented by the same User-Agent
 * it was issued to. Anything else returns null (callers must give one
 * generic error — never say which condition failed).
 *
 * The conditions are part of the UPDATE's WHERE clause, so a request that
 * fails a condition (wrong User-Agent, expired) does NOT consume the grant
 * and cannot be used to burn a legitimate admin's grant.
 *
 * Pass a transaction client and do the password update in that same
 * transaction so "consume grant" and "change password" commit or roll back
 * together.
 */
export async function consumeRecoveryGrant(
  input: { token: unknown; userAgent?: string | null },
  db: Db = prisma
): Promise<ConsumedRecoveryGrant | null> {
  if (!isWellFormedGrantToken(input.token)) return null;

  const tokenHash = hashGrantToken(input.token);
  const now = new Date();

  const claimed = await db.adminRecoveryGrant.updateMany({
    where: {
      tokenHash,
      userAgentHash: hashUserAgent(input.userAgent),
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) return null;

  const grant = await db.adminRecoveryGrant.findUnique({
    where: { tokenHash },
    select: { userId: true, method: true },
  });
  return grant ?? null;
}

/**
 * Invalidates every still-outstanding grant for an account. Phase 3 calls
 * this inside the password-reset transaction so no other grant minted for
 * the same account survives a successful reset.
 */
export async function invalidateOutstandingGrants(userId: string, db: Db = prisma): Promise<number> {
  const result = await db.adminRecoveryGrant.updateMany({
    where: { userId, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return result.count;
}
