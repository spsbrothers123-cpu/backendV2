import { prisma } from "../lib/prisma.js";

export const LOCK_TTL_MS = 5 * 60_000;

export interface AcquiredJob {
  cursorAt: Date | null;
  lastSuccessAt: Date | null;
}

/**
 * Database-backed execution lock (D-24). One atomic INSERT … ON CONFLICT DO
 * UPDATE … WHERE: the row is taken only if nobody holds it or the holder's
 * lease has expired (a crashed instance's lock frees itself after the TTL).
 * Exactly one concurrent caller gets a row back; everyone else gets none.
 */
export async function acquireJob(key: string, owner: string, now: Date, ttlMs = LOCK_TTL_MS): Promise<AcquiredJob | null> {
  // ISO strings cast with ::timestamp: the columns are naive-UTC (Prisma's convention), and
  // casting drops the zone designator, so the comparison is correct whatever the session TimeZone is.
  const untilIso = new Date(now.getTime() + ttlMs).toISOString();
  const nowIso = now.toISOString();
  const rows = await prisma.$queryRaw<{ cursorAt: Date | null; lastSuccessAt: Date | null }[]>`
    INSERT INTO "notification_job_state" ("key","lockedBy","lockedUntil","lastStartedAt","updatedAt")
    VALUES (${key}, ${owner}, ${untilIso}::timestamp, ${nowIso}::timestamp, ${nowIso}::timestamp)
    ON CONFLICT ("key") DO UPDATE
      SET "lockedBy" = ${owner}, "lockedUntil" = ${untilIso}::timestamp, "lastStartedAt" = ${nowIso}::timestamp, "updatedAt" = ${nowIso}::timestamp
      WHERE "notification_job_state"."lockedUntil" IS NULL OR "notification_job_state"."lockedUntil" < ${nowIso}::timestamp
    RETURNING "cursorAt","lastSuccessAt"`;
  return rows[0] ?? null;
}

export async function releaseJob(
  key: string,
  owner: string,
  outcome: { success: true; cursorAt?: Date | null; now: Date } | { success: false; error: string; now: Date }
): Promise<void> {
  // `lockedBy: owner` guard: a run that overran its lease can't clobber the new holder's state.
  if (outcome.success) {
    await prisma.notificationJobState.updateMany({
      where: { key, lockedBy: owner },
      data: {
        lockedBy: null,
        lockedUntil: null,
        lastSuccessAt: outcome.now,
        lastError: null,
        failureCount: 0,
        ...(outcome.cursorAt !== undefined ? { cursorAt: outcome.cursorAt } : {}),
      },
    });
  } else {
    await prisma.notificationJobState.updateMany({
      where: { key, lockedBy: owner },
      data: { lockedBy: null, lockedUntil: null, lastError: outcome.error.slice(0, 500), failureCount: { increment: 1 } },
    });
  }
}

export async function readJobState(key: string) {
  return prisma.notificationJobState.findUnique({ where: { key } });
}
