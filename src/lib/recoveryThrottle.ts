import type { AdminRecoveryEvent, AdminRecoveryMethod } from "@prisma/client";
import { prisma } from "./prisma.js";
import { recordRecoveryAudit, type Db, type RecoveryAuditInput } from "./recoveryAudit.js";

/**
 * Durable, per-account and per-IP throttling for recovery attempts.
 *
 * Why not just @fastify/rate-limit? That limiter is in-memory and per
 * server instance, keyed by IP only. A recovery endpoint needs limits that
 * (a) survive restarts and hold across multiple instances, and (b) apply
 * per ACCOUNT even when an attacker rotates IPs. So the counts come from
 * the admin_recovery_audit ledger. (The route-level IP limiter should still
 * be kept in front of this as a cheap first filter.)
 *
 * Account key: hashRecoverySubject(email) — the SAME key for existing and
 * non-existing emails, so an attacker cannot tell the two apart by whether
 * throttling kicks in.
 *
 * Policy (initial values, agreed): the first 5 failed verifications per
 * account in a rolling 15 minutes are free; from the 5th failure onward the
 * account is blocked for an escalating delay (30s, 60s, 120s … capped at
 * 15 minutes) measured from the most recent failure. There is no permanent
 * lockout, so an attacker cannot lock a real admin out for good. Separately,
 * 20 failures per IP per rolling hour blocks that IP until the oldest
 * counted failure ages out.
 *
 * Callers MUST: 1) call checkRecoveryThrottle() BEFORE verifying anything
 * and reject without verifying when blocked; 2) record every failed
 * verification via recordFailedCodeVerification(); 3) record blocked
 * attempts via recordThrottledAttempt() (these do not extend the block).
 */

export const RECOVERY_THROTTLE = {
  account: { freeFailures: 5, windowMs: 15 * 60_000, baseDelayMs: 30_000, maxDelayMs: 15 * 60_000 },
  ip: { maxFailures: 20, windowMs: 60 * 60_000 },
} as const;

export interface ThrottleDecision {
  blocked: boolean;
  /** Hint for a Retry-After header; 0 when not blocked. */
  retryAfterSeconds: number;
  scope: "ACCOUNT" | "IP" | null;
}

const ALLOWED: ThrottleDecision = { blocked: false, retryAfterSeconds: 0, scope: null };

/** Pure: decides from the failure count in the window and the time of the latest failure. */
export function accountThrottleDecision(
  failuresInWindow: number,
  lastFailureAt: Date | null,
  now: Date
): ThrottleDecision {
  const p = RECOVERY_THROTTLE.account;
  if (failuresInWindow < p.freeFailures || !lastFailureAt) return ALLOWED;

  // Cap the exponent so 2 ** n can never overflow/become Infinity.
  const exponent = Math.min(failuresInWindow - p.freeFailures, 20);
  const delayMs = Math.min(p.baseDelayMs * 2 ** exponent, p.maxDelayMs);

  // Clamp to delayMs: if the failure's timestamp is slightly AFTER `now`
  // (DB/app clock drift, or `now` captured before the failure was written),
  // the remaining time must never exceed the configured delay. Without this,
  // Math.ceil could report e.g. 31s for a 30s delay.
  const remainingMs = Math.min(lastFailureAt.getTime() + delayMs - now.getTime(), delayMs);

  return remainingMs > 0
    ? { blocked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000), scope: "ACCOUNT" }
    : ALLOWED;
}

/**
 * Pure: `releasingFailureAt` is the failure whose aging-out drops the count
 * below the limit (the (count - max + 1)th oldest in the window).
 */
export function ipThrottleDecision(
  failuresInWindow: number,
  releasingFailureAt: Date | null,
  now: Date
): ThrottleDecision {
  const p = RECOVERY_THROTTLE.ip;
  if (failuresInWindow < p.maxFailures || !releasingFailureAt) return ALLOWED;

  // Same clamp as the account scope: never report more than the window.
  const remainingMs = Math.min(releasingFailureAt.getTime() + p.windowMs - now.getTime(), p.windowMs);
  return remainingMs > 0
    ? { blocked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000), scope: "IP" }
    : ALLOWED;
}

/** Pure: if both scopes block, report the one that lasts longer. */
export function combineThrottleDecisions(a: ThrottleDecision, b: ThrottleDecision): ThrottleDecision {
  if (a.blocked && b.blocked) return a.retryAfterSeconds >= b.retryAfterSeconds ? a : b;
  return a.blocked ? a : b;
}

// Phase 3: recovery-code AND passkey failures share ONE per-account budget, so
// an attacker cannot double their guesses by alternating methods.
const VERIFICATION_EVENTS: AdminRecoveryEvent[] = ["CODE_VERIFICATION", "PASSKEY_VERIFICATION"];

const failureWhere = (since: Date) => ({
  event: { in: VERIFICATION_EVENTS },
  outcome: "FAILURE" as const,
  createdAt: { gte: since },
});

export async function checkRecoveryThrottle(
  input: { subjectHash?: string | null; ip?: string | null },
  now: Date = new Date(),
  db: Db = prisma
): Promise<ThrottleDecision> {
  let account = ALLOWED;
  let ip = ALLOWED;

  if (input.subjectHash) {
    const where = {
      subjectHash: input.subjectHash,
      ...failureWhere(new Date(now.getTime() - RECOVERY_THROTTLE.account.windowMs)),
    };
    const agg = await db.adminRecoveryAudit.aggregate({
      where,
      _count: { _all: true },
      _max: { createdAt: true },
    });
    account = accountThrottleDecision(agg._count._all, agg._max.createdAt, now);
  }

  if (input.ip) {
    const where = { ip: input.ip, ...failureWhere(new Date(now.getTime() - RECOVERY_THROTTLE.ip.windowMs)) };
    const count = await db.adminRecoveryAudit.count({ where });
    let releasing: Date | null = null;
    if (count >= RECOVERY_THROTTLE.ip.maxFailures) {
      const row = await db.adminRecoveryAudit.findMany({
        where,
        orderBy: { createdAt: "asc" },
        skip: count - RECOVERY_THROTTLE.ip.maxFailures,
        take: 1,
        select: { createdAt: true },
      });
      releasing = row[0]?.createdAt ?? null;
    }
    ip = ipThrottleDecision(count, releasing, now);
  }

  return combineThrottleDecisions(account, ip);
}

type AttemptContext = Pick<RecoveryAuditInput, "userId" | "subjectHash" | "ip" | "userAgent">;

/** Records a failed code verification — this is the row the throttle counts. Use for unknown accounts too (userId omitted). */
export async function recordFailedCodeVerification(ctx: AttemptContext, db: Db = prisma): Promise<void> {
  await recordRecoveryAudit(
    { ...ctx, event: "CODE_VERIFICATION", outcome: "FAILURE", method: "RECOVERY_CODE" },
    db
  );
}

/** Same, for a failed passkey assertion (counted by the same throttle). */
export async function recordFailedPasskeyVerification(ctx: AttemptContext, db: Db = prisma): Promise<void> {
  await recordRecoveryAudit(
    { ...ctx, event: "PASSKEY_VERIFICATION", outcome: "FAILURE", method: "PASSKEY" },
    db
  );
}

/** Records an attempt that was rejected because it was throttled. Deliberately NOT counted as a failure. */
export async function recordThrottledAttempt(
  ctx: AttemptContext,
  decision: ThrottleDecision,
  db: Db = prisma,
  method: AdminRecoveryMethod = "RECOVERY_CODE"
): Promise<void> {
  await recordRecoveryAudit(
    {
      ...ctx,
      event: "ATTEMPT_THROTTLED",
      outcome: "FAILURE",
      method,
      metadata: { scope: decision.scope, retryAfterSeconds: decision.retryAfterSeconds },
    },
    db
  );
}