/**
 * Asia/Kolkata (IST) — the authoritative business timezone (Phase 3, D-06).
 *
 * India has no daylight-saving time and has used a fixed UTC+05:30 offset
 * since 1945, so IST arithmetic is exact with a constant offset. Nothing here
 * reads the server's or client's local timezone.
 */
export const BUSINESS_TZ = "Asia/Kolkata";
export const IST_OFFSET_MINUTES = 330;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isValidDateString(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** The IST calendar date (YYYY-MM-DD) that instant `d` falls on. */
export function istDateString(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant at which the given IST calendar date starts (00:00 IST). */
export function istStartOfDay(date: string): Date {
  if (!isValidDateString(date)) throw new RangeError(`Invalid date: ${date}`);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - IST_OFFSET_MS);
}

/** Shift a YYYY-MM-DD string by whole days. */
export function addDays(date: string, days: number): string {
  if (!isValidDateString(date)) throw new RangeError(`Invalid date: ${date}`);
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Minutes since 00:00 IST for instant `d`. */
export function istMinutesOfDay(d: Date): number {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** The instant of `minutes` past 00:00 IST on the IST calendar date `date`. */
export function istInstant(date: string, minutes: number): Date {
  return new Date(istStartOfDay(date).getTime() + minutes * 60_000);
}

/** "HH:MM" → minutes since midnight, or null if not a valid 24h time. */
export function parseHHMM(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export interface InstantRange {
  /** inclusive lower bound */
  gte?: Date;
  /** exclusive upper bound */
  lt?: Date;
}

/**
 * Inclusive IST date range (Admin `dateFrom`/`dateTo`, YYYY-MM-DD) → half-open
 * instant range [startOf(from), startOf(to + 1 day)). Throws RangeError on a
 * malformed date so callers can answer 422.
 */
export function istDateRange(dateFrom?: string, dateTo?: string): InstantRange {
  const range: InstantRange = {};
  if (dateFrom) range.gte = istStartOfDay(dateFrom);
  if (dateTo) range.lt = istStartOfDay(addDays(dateTo, 1));
  return range;
}

/**
 * Cashier `from` / `to` bound. A bare YYYY-MM-DD is an IST calendar day
 * (inclusive); a full ISO timestamp is an exact instant (inclusive). This is
 * the D-06 fix: a date-only filter no longer shifts by the browser's/server's
 * timezone.
 */
export function parseBound(value: string | undefined, edge: "from" | "to"): InstantRange {
  if (!value) return {};
  if (isValidDateString(value)) {
    return edge === "from" ? { gte: istStartOfDay(value) } : { lt: istStartOfDay(addDays(value, 1)) };
  }
  const t = Date.parse(value);
  if (!Number.isFinite(t) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new RangeError(`Invalid date/time: ${value}`);
  return edge === "from" ? { gte: new Date(t) } : { lt: new Date(t + 1) };
}

export function mergeRanges(a: InstantRange, b: InstantRange): InstantRange {
  return { ...a, ...b };
}
