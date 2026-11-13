/**
 * Pure IST schedule maths for daily summaries (D-22) and branch reminders
 * (D-18). No I/O: the caller supplies `now`, so restart/catch-up behaviour is
 * deterministic and unit-testable.
 */
import { addDays, istDateString, istInstant } from "../lib/ist.js";
import { NOTIFICATION_DEFAULTS } from "./constants.js";

export type SummaryKindKey = "MAIN" | "SUPPLEMENTARY";

/**
 * MAIN          12:00 AM → 10:00 PM IST of `date`
 * SUPPLEMENTARY 10:00 PM → 12:00 AM IST (end of `date`)
 */
export function summaryWindow(date: string, kind: SummaryKindKey): { start: Date; end: Date } {
  const cut = NOTIFICATION_DEFAULTS.summary.mainAtMinutes;
  return kind === "MAIN"
    ? { start: istInstant(date, 0), end: istInstant(date, cut) }
    : { start: istInstant(date, cut), end: istInstant(addDays(date, 1), 0) };
}

/** When the summary is generated: MAIN 10:00 PM on `date`; SUPPLEMENTARY 12:05 AM the next day. */
export function summaryDueAt(date: string, kind: SummaryKindKey): Date {
  return kind === "MAIN"
    ? istInstant(date, NOTIFICATION_DEFAULTS.summary.mainAtMinutes)
    : istInstant(addDays(date, 1), NOTIFICATION_DEFAULTS.summary.supplementaryAtMinutes);
}

/** Every summary whose generation time has passed, looking back `lookbackDays` business days (catch-up). */
export function dueSummaries(now: Date, lookbackDays = 2): { date: string; kind: SummaryKindKey; dueAt: Date }[] {
  const today = istDateString(now);
  const out: { date: string; kind: SummaryKindKey; dueAt: Date }[] = [];
  for (let back = lookbackDays; back >= 0; back--) {
    const date = addDays(today, -back);
    for (const kind of ["MAIN", "SUPPLEMENTARY"] as const) {
      const dueAt = summaryDueAt(date, kind);
      if (dueAt <= now) out.push({ date, kind, dueAt });
    }
  }
  return out;
}

/** Public id used by GET /admin/daily-summaries/:id — MAIN is the bare date (Admin contract). */
export function summaryApiId(date: string, kind: SummaryKindKey): string {
  return kind === "MAIN" ? date : `${date}-supplementary`;
}

export function parseSummaryApiId(id: string): { date: string; kind: SummaryKindKey } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(-supplementary)?$/.exec(id);
  return m ? { date: m[1], kind: m[2] ? "SUPPLEMENTARY" : "MAIN" } : null;
}

export interface ReminderSlot {
  date: string;
  kind: "opening" | "closing";
  slotAt: Date;
}

/**
 * Reminder slots currently "live": the slot time has passed, but by no more
 * than the grace window. The grace window is the catch-up: if the backend was
 * down at 9:00 and comes back at 9:40, the 9:00 reminder still goes out; at
 * 14:00 it no longer does (stale). Checks today and yesterday (IST) so a late
 * closing time + grace can cross midnight.
 */
export function liveReminderSlots(
  now: Date,
  cfg: { openingMinutes: number | null; closingMinutes: number | null },
  graceMinutes = NOTIFICATION_DEFAULTS.reminderGraceMinutes
): ReminderSlot[] {
  const today = istDateString(now);
  const out: ReminderSlot[] = [];
  for (const date of [addDays(today, -1), today]) {
    const defs: [ReminderSlot["kind"], number | null][] = [
      ["opening", cfg.openingMinutes],
      ["closing", cfg.closingMinutes],
    ];
    for (const [kind, minutes] of defs) {
      if (minutes === null) continue;
      const slotAt = istInstant(date, minutes);
      const age = now.getTime() - slotAt.getTime();
      if (age >= 0 && age <= graceMinutes * 60_000) out.push({ date, kind, slotAt });
    }
  }
  return out;
}
