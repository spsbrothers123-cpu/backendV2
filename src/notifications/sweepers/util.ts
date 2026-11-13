import { BATCH_SIZE, MAX_BATCHES_PER_RUN, type SweepResult } from "./types.js";
import { istDateString } from "../../lib/ist.js";

export function rupees(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 Nov 2026" in IST */
export function istLabel(d: Date): string {
  const [y, m, day] = istDateString(d).split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export type Cursor = { ts: Date; id: string } | null;

export interface DrainOptions<T extends { id: string }> {
  fetch: (after: { ts: Date; id: string } | null, take: number) => Promise<T[]>;
  ts: (row: T) => Date;
  /** returns how many notifications this row created */
  handle: (row: T) => Promise<number>;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

/**
 * Keyset-paged sweep of source rows ordered by (timestamp, id). One bad row
 * never stops the others: it is logged and counted, and the run reports the
 * earliest failing timestamp so the watermark does not move past it.
 */
export async function drain<T extends { id: string }>(opts: DrainOptions<T>): Promise<SweepResult> {
  let after: { ts: Date; id: string } | null = null;
  let examined = 0;
  let created = 0;
  let failures = 0;
  let earliestFailure: Date | null = null;
  let resumeFrom: Date | undefined;

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
    const rows = await opts.fetch(after, BATCH_SIZE);
    for (const row of rows) {
      examined++;
      try {
        created += await opts.handle(row);
      } catch (err) {
        failures++;
        const t = opts.ts(row);
        if (!earliestFailure || t < earliestFailure) earliestFailure = t;
        (opts.log ?? ((m, x) => console.error(m, x)))("notification sweep row failed", { rowId: row.id, error: (err as Error).message });
      }
    }
    if (rows.length < BATCH_SIZE) break;
    const last = rows[rows.length - 1];
    after = { ts: opts.ts(last), id: last.id };
    if (batch === MAX_BATCHES_PER_RUN - 1) resumeFrom = after.ts; // more remains: continue next run
  }
  if (earliestFailure && (!resumeFrom || earliestFailure < resumeFrom)) resumeFrom = earliestFailure;
  return { examined, created, failures, resumeFrom };
}

/** keyset predicate for a (tsField, id) ordering, strictly after `after` */
export function afterKey<F extends string>(field: F, after: { ts: Date; id: string } | null) {
  return after ? { OR: [{ [field]: { gt: after.ts } }, { [field]: after.ts, id: { gt: after.id } }] } : {};
}
