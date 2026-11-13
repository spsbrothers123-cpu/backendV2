import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { NOTIFICATION_DEFAULTS } from "./constants.js";
import { acquireJob, readJobState, releaseJob } from "./jobState.js";
import type { SweepJob, SweepResult } from "./sweepers/types.js";

export type RunOutcome = "ok" | "failed" | "not_due" | "locked";

const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;

export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const consoleLogger: Logger = {
  info: (o, m) => console.warn(m, o), // eslint no-console allows warn/error only
  error: (o, m) => console.error(m, o),
};

/** Pure: where the next run's watermark goes. */
export function nextCursor(job: SweepJob, result: SweepResult, now: Date): Date | undefined {
  if (!job.watermarked) return undefined;
  const normal = new Date(now.getTime() - NOTIFICATION_DEFAULTS.sweepOverlapMs);
  if (!result.resumeFrom) return normal;
  // A poison row must not pin the watermark forever.
  if ((result.failures ?? 0) > 0 && now.getTime() - result.resumeFrom.getTime() > GIVE_UP_AFTER_MS) return normal;
  return result.resumeFrom;
}

/**
 * Runs ONE job once, with the database lock, catch-up and failure handling.
 *   not_due — ran successfully (or started) less than `intervalMs` ago
 *   locked  — another instance holds the lease
 * Never throws: a failing job is recorded (lastError/failureCount) and retried
 * on a later tick; restart recovery is just "the next tick picks up the
 * persisted watermark".
 */
export async function runJobOnce(job: SweepJob, owner: string, now: Date, log: Logger = consoleLogger): Promise<RunOutcome> {
  try {
    const state = await readJobState(job.key);
    const lastStart = state?.lastStartedAt ?? null;
    if (lastStart && now.getTime() - lastStart.getTime() < job.intervalMs) return "not_due";

    const lease = await acquireJob(job.key, owner, now);
    if (!lease) return "locked";

    try {
      const since = lease.cursorAt ?? new Date(now.getTime() - NOTIFICATION_DEFAULTS.initialLookbackMs);
      const result = await job.run({ now, since });
      await releaseJob(job.key, owner, { success: true, cursorAt: nextCursor(job, result, now), now });
      if (result.created > 0 || (result.failures ?? 0) > 0) {
        log.info({ job: job.key, ...result }, "notification job finished");
      }
      return (result.failures ?? 0) > 0 ? "failed" : "ok";
    } catch (err) {
      const message = (err as Error).message;
      log.error({ job: job.key, error: message }, "notification job failed");
      await releaseJob(job.key, owner, { success: false, error: message, now }).catch(() => undefined);
      return "failed";
    }
  } catch (err) {
    log.error({ job: job.key, error: (err as Error).message }, "notification scheduler error");
    return "failed";
  }
}

export interface SchedulerHandle {
  stop(): void;
  /** run one pass over every job now (used on boot for catch-up, and by tests) */
  tick(): Promise<void>;
  readonly instanceId: string;
}

/**
 * In-process scheduler (D-24). A short tick evaluates every job; each job's own
 * interval + DB lock decide whether it really runs, so several backend
 * instances can run this simultaneously without duplicating work. The first
 * tick runs immediately: that IS the restart catch-up.
 */
export function startNotificationScheduler(jobs: SweepJob[], opts: { tickMs?: number; log?: Logger; clock?: () => Date } = {}): SchedulerHandle {
  const instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const log = opts.log ?? consoleLogger;
  const clock = opts.clock ?? (() => new Date());
  let running = false;

  const tick = async () => {
    if (running) return; // never overlap ticks inside one process
    running = true;
    try {
      for (const job of jobs) await runJobOnce(job, instanceId, clock(), log);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), opts.tickMs ?? 30_000);
  timer.unref();
  setTimeout(() => void tick(), 2_000).unref(); // catch-up shortly after boot, once the server is listening
  return { stop: () => clearInterval(timer), tick, instanceId };
}
