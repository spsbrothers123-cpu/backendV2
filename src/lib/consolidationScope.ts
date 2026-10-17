import { Errors } from "./errors.js";
import { listShopsForAdmin } from "./shopAccess.js";

/**
 * Consolidation scoping + date handling.
 *
 * Deliberately independent of the "global shop selector": that selector is
 * stored server-side as User.shopId (see routes/admin/shops.ts /switch) and
 * every other admin route reads request.authUser.shopId. Nothing in this
 * file ever reads or writes it — authorized shops come ONLY from the
 * authenticated admin's id via listShopsForAdmin (AdminShopLink + legacy
 * fallback), and an optional client-supplied shop filter is validated
 * against that list.
 */

export interface ScopedShop {
  id: string;
  name: string;
  code: string;
}

export interface ConsolidationScope {
  /** Shops the query may touch (all authorized, or the single validated one). */
  shops: ScopedShop[];
  /** null = "All Shops". */
  selectedShopId: string | null;
}

export async function resolveConsolidationScope(
  adminId: string,
  shopParam?: string | null
): Promise<ConsolidationScope> {
  const authorized = await listShopsForAdmin(adminId);
  const all: ScopedShop[] = authorized.map((s) => ({ id: s.id, name: s.name, code: s.code }));

  const wanted = (shopParam ?? "").trim();
  if (wanted === "" || wanted.toLowerCase() === "all") {
    return { shops: all, selectedShopId: null };
  }
  const match = all.find((s) => s.id === wanted);
  if (!match) {
    throw Errors.forbidden("You don't have access to that shop.", "SHOP_ACCESS_DENIED");
  }
  return { shops: [match], selectedShopId: match.id };
}

// ── Business-local date handling ──────────────────────────────────────
// The app targets India (no DST), but the server usually runs in UTC, so
// "today" must be computed against a fixed business offset rather than the
// server's local clock. Default +05:30; override with
// BUSINESS_UTC_OFFSET_MINUTES.

export function businessOffsetMinutes(): number {
  const raw = Number(process.env.BUSINESS_UTC_OFFSET_MINUTES);
  return Number.isFinite(raw) && process.env.BUSINESS_UTC_OFFSET_MINUTES !== "" && process.env.BUSINESS_UTC_OFFSET_MINUTES !== undefined
    ? raw
    : 330;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isValidYmd(value: string): boolean {
  if (!YMD_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** yyyy-mm-dd of an instant, as seen on the business-local calendar. */
export function ymdInBusinessTime(date: Date, offsetMin = businessOffsetMinutes()): string {
  return new Date(date.getTime() + offsetMin * 60_000).toISOString().slice(0, 10);
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** First instant (UTC) of a business-local calendar day. */
export function startOfBusinessDay(ymd: string, offsetMin = businessOffsetMinutes()): Date {
  return new Date(new Date(`${ymd}T00:00:00Z`).getTime() - offsetMin * 60_000);
}

/** Last millisecond (UTC) of a business-local calendar day. */
export function endOfBusinessDay(ymd: string, offsetMin = businessOffsetMinutes()): Date {
  return new Date(startOfBusinessDay(ymd, offsetMin).getTime() + DAY_MS - 1);
}

/** "01 Oct" */
export function shortDayLabel(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${d} ${MONTHS[Number(m) - 1]}`;
}

export type ConsolidationRange = "today" | "yesterday" | "last7" | "last30" | "custom";

export interface ConsolidationPeriod {
  range: ConsolidationRange;
  fromYmd: string;
  toYmd: string;
  /** Inclusive instants used in queries. */
  from: Date;
  to: Date;
  label: string;
}

export function daysInPeriod(period: Pick<ConsolidationPeriod, "fromYmd" | "toYmd">): string[] {
  const out: string[] = [];
  for (let d = period.fromYmd; d <= period.toYmd; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

const RANGE_LABEL: Record<Exclude<ConsolidationRange, "custom">, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 Days",
  last30: "Last 30 Days",
};

export function resolveConsolidationPeriod(
  input: { range?: string; dateFrom?: string; dateTo?: string },
  now: Date = new Date(),
  offsetMin = businessOffsetMinutes()
): ConsolidationPeriod {
  const range = (input.range?.trim() || (input.dateFrom && input.dateTo ? "custom" : "last7")) as ConsolidationRange;
  const today = ymdInBusinessTime(now, offsetMin);

  let fromYmd: string;
  let toYmd: string;
  switch (range) {
    case "today":
      fromYmd = toYmd = today;
      break;
    case "yesterday":
      fromYmd = toYmd = addDaysYmd(today, -1);
      break;
    case "last7":
      fromYmd = addDaysYmd(today, -6);
      toYmd = today;
      break;
    case "last30":
      fromYmd = addDaysYmd(today, -29);
      toYmd = today;
      break;
    case "custom": {
      if (!input.dateFrom || !input.dateTo) {
        throw Errors.badRequest("Choose both a start and an end date.", "INVALID_DATE_RANGE");
      }
      if (!isValidYmd(input.dateFrom) || !isValidYmd(input.dateTo)) {
        throw Errors.badRequest("Dates must be in YYYY-MM-DD format.", "INVALID_DATE_RANGE");
      }
      if (input.dateFrom > input.dateTo) {
        throw Errors.badRequest("The start date must not be after the end date.", "INVALID_DATE_RANGE");
      }
      fromYmd = input.dateFrom;
      toYmd = input.dateTo;
      const span = (new Date(`${toYmd}T00:00:00Z`).getTime() - new Date(`${fromYmd}T00:00:00Z`).getTime()) / DAY_MS + 1;
      if (span > MAX_RANGE_DAYS) {
        throw Errors.badRequest("Date range too large. Choose a range of one year or less.", "INVALID_DATE_RANGE");
      }
      break;
    }
    default:
      throw Errors.badRequest("Unknown date range.", "INVALID_DATE_RANGE");
  }

  return {
    range,
    fromYmd,
    toYmd,
    from: startOfBusinessDay(fromYmd, offsetMin),
    to: endOfBusinessDay(toYmd, offsetMin),
    label: range === "custom" ? `${fromYmd} to ${toYmd}` : `${RANGE_LABEL[range]} (${fromYmd}${fromYmd === toYmd ? "" : ` to ${toYmd}`})`,
  };
}
