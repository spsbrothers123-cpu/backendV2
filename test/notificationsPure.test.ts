/** Phase 3 — pure logic: IST, thresholds, schedule, cursor, registry mapping. No DB. */
import { describe, expect, it, vi } from "vitest";
import type { NtfCategory } from "@prisma/client";

// Pure-logic test: modules below import the Prisma singleton, which this file never uses.
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import { addDays, isValidDateString, istDateRange, istDateString, istInstant, istMinutesOfDay, istStartOfDay, parseBound, parseHHMM } from "../src/lib/ist.js";
import {
  cashDifference, effectiveLowStockThreshold, failedLoginBursts, hasCashMismatch, isCreditOverdue, isHighValueSale,
  isLargeCreditSale, maskEmail, oldestUnpaidCharge, stockState, stockTransitionEvent,
} from "../src/notifications/thresholds.js";
import { dueSummaries, liveReminderSlots, parseSummaryApiId, summaryApiId, summaryDueAt, summaryWindow } from "../src/notifications/schedule.js";
import { decodeCursor, encodeCursor } from "../src/notifications/cursor.js";
import { ADMIN_CATEGORIES, CASHIER_CATEGORIES, LOCKED_CATEGORIES, TYPES, cashierApiType, categoryFromSlug, categorySlug, NOTIFICATION_DEFAULTS } from "../src/notifications/constants.js";
import { nextCursor } from "../src/notifications/scheduler.js";
import { computeExpiry, composeDedupeKey } from "../src/notifications/service.js";
import { SUMMARY_METRIC_KEYS, sumFigures, toMetrics } from "../src/notifications/dailySummary.js";

describe("IST helpers", () => {
  it("maps instants to the IST calendar day (UTC 18:30 rolls the day)", () => {
    expect(istDateString(new Date("2026-11-05T18:29:59Z"))).toBe("2026-11-05");
    expect(istDateString(new Date("2026-11-05T18:30:00Z"))).toBe("2026-11-06");
  });
  it("start of IST day is 18:30 UTC the previous day", () => {
    expect(istStartOfDay("2026-11-05").toISOString()).toBe("2026-11-04T18:30:00.000Z");
  });
  it("Admin dateFrom/dateTo is inclusive in IST", () => {
    const r = istDateRange("2026-11-05", "2026-11-05");
    expect(r.gte!.toISOString()).toBe("2026-11-04T18:30:00.000Z");
    expect(r.lt!.toISOString()).toBe("2026-11-05T18:30:00.000Z");
  });
  it("D-06 Cashier fix: date-only bounds are IST days, ISO bounds are exact", () => {
    expect(parseBound("2026-11-05", "from").gte!.toISOString()).toBe("2026-11-04T18:30:00.000Z");
    expect(parseBound("2026-11-05", "to").lt!.toISOString()).toBe("2026-11-05T18:30:00.000Z");
    expect(parseBound("2026-11-05T10:00:00Z", "from").gte!.toISOString()).toBe("2026-11-05T10:00:00.000Z");
    expect(parseBound("2026-11-05T10:00:00Z", "to").lt!.getTime()).toBe(Date.parse("2026-11-05T10:00:00Z") + 1);
    expect(parseBound(undefined, "from")).toEqual({});
  });
  it("rejects malformed dates", () => {
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(() => istStartOfDay("nope")).toThrow(RangeError);
    expect(() => parseBound("yesterday", "from")).toThrow(RangeError);
    expect(() => parseBound("2026-11-05 10:00", "to")).toThrow(RangeError);
  });
  it("day arithmetic, minutes-of-day, HH:MM parsing", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(istMinutesOfDay(new Date("2026-11-05T16:30:00Z"))).toBe(22 * 60);
    expect(istInstant("2026-11-05", 22 * 60).toISOString()).toBe("2026-11-05T16:30:00.000Z");
    expect(parseHHMM("09:30")).toBe(570);
    expect(parseHHMM("24:00")).toBeNull();
    expect(parseHHMM("9:30")).toBeNull();
    expect(parseHHMM(null)).toBeNull();
  });
});

describe("thresholds (D-19 inclusive >=, zero-tolerance mismatch)", () => {
  it("high-value uses >= 5000", () => {
    expect(isHighValueSale(4999.99, 5000)).toBe(false);
    expect(isHighValueSale(5000, 5000)).toBe(true);
    expect(isHighValueSale("5000.00", 5000)).toBe(true);
  });
  it("large credit uses >= 10000 on the credit portion only", () => {
    expect(isLargeCreditSale(9999.99, 10000)).toBe(false);
    expect(isLargeCreditSale(10000, 10000)).toBe(true);
    expect(isLargeCreditSale(0, 0)).toBe(false);
  });
  it("floating-point noise cannot flip a comparison", () => {
    expect(isHighValueSale(0.1 + 0.2 + 4999.7, 5000)).toBe(true);
  });
  it("any non-zero cash difference is a mismatch; zero is not", () => {
    expect(hasCashMismatch(1000, 1000)).toBe(false);
    expect(hasCashMismatch(1000.01, 1000)).toBe(true);
    expect(hasCashMismatch(999.99, 1000)).toBe(true);
    expect(hasCashMismatch(1000, 1000, 5)).toBe(false);
    expect(cashDifference(990, 1000)).toBe(-10);
  });
});

describe("stock transitions (D-17)", () => {
  it("state rule matches productStatusLabel", () => {
    expect(stockState(0, 10)).toBe("OUT");
    expect(stockState(-3, 10)).toBe("OUT");
    expect(stockState(10, 10)).toBe("LOW");
    expect(stockState(11, 10)).toBe("OK");
    expect(stockState(1, 0)).toBe("OK");
  });
  it("branch override wins; product value is the fallback", () => {
    expect(effectiveLowStockThreshold(20, 5)).toBe(5);
    expect(effectiveLowStockThreshold(20, 0)).toBe(0);
    expect(effectiveLowStockThreshold(20, null)).toBe(20);
    expect(effectiveLowStockThreshold(20, undefined)).toBe(20);
  });
  it("fires once per transition, never on no-change", () => {
    expect(stockTransitionEvent(null, "OK")).toBeNull();
    expect(stockTransitionEvent(null, "LOW")).toBe("inventory.low_stock");
    expect(stockTransitionEvent(null, "OUT")).toBe("inventory.out_of_stock");
    expect(stockTransitionEvent("OK", "LOW")).toBe("inventory.low_stock");
    expect(stockTransitionEvent("LOW", "OUT")).toBe("inventory.out_of_stock");
    expect(stockTransitionEvent("OUT", "LOW")).toBe("inventory.restocked");
    expect(stockTransitionEvent("LOW", "OK")).toBe("inventory.restocked");
    expect(stockTransitionEvent("OUT", "OK")).toBe("inventory.restocked");
    expect(stockTransitionEvent("LOW", "LOW")).toBeNull();
  });
});

describe("credit ageing", () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  it("collections settle the OLDEST charges first (FIFO)", () => {
    const rows = [
      { id: "c1", type: "CHARGE" as const, amountCents: 10000, createdAt: d("2026-09-01") },
      { id: "c2", type: "CHARGE" as const, amountCents: 5000, createdAt: d("2026-10-01") },
      { id: "p1", type: "COLLECTION" as const, amountCents: 12000, createdAt: d("2026-10-05") },
    ];
    const o = oldestUnpaidCharge(rows)!;
    expect(o.id).toBe("c2");
    expect(o.unpaidCents).toBe(3000);
  });
  it("fully settled → null; reversal also settles", () => {
    expect(oldestUnpaidCharge([{ type: "CHARGE", amountCents: 100, createdAt: d("2026-09-01") }, { type: "REVERSAL", amountCents: 100, createdAt: d("2026-09-02") }])).toBeNull();
    expect(oldestUnpaidCharge([])).toBeNull();
  });
  it("overdue is age >= days", () => {
    const charged = d("2026-10-01");
    expect(isCreditOverdue(charged, d("2026-10-30"), 30)).toBe(false);
    expect(isCreditOverdue(charged, d("2026-10-31"), 30)).toBe(true);
  });
});

describe("failed-login bursts (D-20: 5 in 10 minutes)", () => {
  const ev = (id: string, min: number) => ({ id, at: new Date(Date.UTC(2026, 10, 5, 10, min, 0)) });
  it("5 within 10 minutes triggers", () => {
    const b = failedLoginBursts([ev("a", 0), ev("b", 2), ev("c", 4), ev("d", 6), ev("e", 10)], 5, 10);
    expect(b).toHaveLength(1);
    expect(b[0].firstId).toBe("a");
  });
  it("4 attempts, or 5 spread over >10 minutes, do not", () => {
    expect(failedLoginBursts([ev("a", 0), ev("b", 1), ev("c", 2), ev("d", 3)], 5, 10)).toHaveLength(0);
    expect(failedLoginBursts([ev("a", 0), ev("b", 3), ev("c", 6), ev("d", 9), ev("e", 11)], 5, 10)).toHaveLength(0);
  });
  it("a long attack yields one alert per 5 failures, with a stable identity", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, i));
    const b = failedLoginBursts(events, 5, 10);
    expect(b.map((x) => x.firstId)).toEqual(["e0", "e5"]);
    expect(failedLoginBursts([...events].reverse(), 5, 10).map((x) => x.firstId)).toEqual(["e0", "e5"]);
  });
  it("masks e-mail addresses", () => {
    expect(maskEmail("jane.doe@gmail.com")).toBe("j***@gmail.com");
    expect(maskEmail("nope")).toBe("***");
  });
});

describe("daily summary schedule (D-22)", () => {
  it("MAIN covers 12AM–10PM IST, SUPPLEMENTARY 10PM–12AM", () => {
    const m = summaryWindow("2026-11-05", "MAIN");
    expect(m.start.toISOString()).toBe("2026-11-04T18:30:00.000Z");
    expect(m.end.toISOString()).toBe("2026-11-05T16:30:00.000Z"); // = 10 PM IST (matches the Admin contract)
    const s = summaryWindow("2026-11-05", "SUPPLEMENTARY");
    expect(s.start.toISOString()).toBe("2026-11-05T16:30:00.000Z");
    expect(s.end.toISOString()).toBe("2026-11-05T18:30:00.000Z");
    expect(m.end.getTime()).toBe(s.start.getTime()); // no gap, no overlap
  });
  it("generated at 10:00 PM and 12:05 AM IST", () => {
    expect(summaryDueAt("2026-11-05", "MAIN").toISOString()).toBe("2026-11-05T16:30:00.000Z");
    expect(summaryDueAt("2026-11-05", "SUPPLEMENTARY").toISOString()).toBe("2026-11-05T18:35:00.000Z");
  });
  it("catch-up: after a long outage every missed slot is due; future slots are not", () => {
    const now = new Date("2026-11-07T03:00:00Z"); // 8:30 AM IST on the 7th
    const due = dueSummaries(now).map((s) => `${s.date}:${s.kind}`);
    expect(due).toContain("2026-11-05:MAIN");
    expect(due).toContain("2026-11-05:SUPPLEMENTARY");
    expect(due).toContain("2026-11-06:MAIN");
    expect(due).toContain("2026-11-06:SUPPLEMENTARY"); // due 12:05 AM on the 7th
    expect(due).not.toContain("2026-11-07:MAIN");
  });
  it("ids round-trip; MAIN is the bare date", () => {
    expect(summaryApiId("2026-11-05", "MAIN")).toBe("2026-11-05");
    expect(parseSummaryApiId("2026-11-05")).toEqual({ date: "2026-11-05", kind: "MAIN" });
    expect(parseSummaryApiId("2026-11-05-supplementary")).toEqual({ date: "2026-11-05", kind: "SUPPLEMENTARY" });
    expect(parseSummaryApiId("../etc")).toBeNull();
  });
  it("exposes exactly the 12 approved metrics in order", () => {
    const keys = toMetrics(sumFigures([])).map((m) => m.key);
    expect(keys).toEqual([...SUMMARY_METRIC_KEYS]);
    expect(keys).toHaveLength(12);
  });
});

describe("reminder slots (D-18, IST)", () => {
  const cfg = { openingMinutes: 9 * 60, closingMinutes: 21 * 60 };
  it("fires within the grace window, not before, not long after (catch-up vs stale)", () => {
    expect(liveReminderSlots(new Date("2026-11-05T03:29:00Z"), cfg)).toHaveLength(0); // 8:59 IST
    expect(liveReminderSlots(new Date("2026-11-05T03:30:00Z"), cfg).map((s) => s.kind)).toEqual(["opening"]); // 9:00 IST
    expect(liveReminderSlots(new Date("2026-11-05T04:10:00Z"), cfg).map((s) => s.kind)).toEqual(["opening"]); // late restart still catches up
    expect(liveReminderSlots(new Date("2026-11-05T08:30:00Z"), cfg)).toHaveLength(0); // 2 PM: stale
  });
  it("null times mean no reminder; closing near midnight crosses the day boundary", () => {
    expect(liveReminderSlots(new Date("2026-11-05T03:30:00Z"), { openingMinutes: null, closingMinutes: null })).toHaveLength(0);
    const late = liveReminderSlots(new Date("2026-11-05T19:00:00Z"), { openingMinutes: null, closingMinutes: 23 * 60 + 30 }); // 00:30 IST on the 6th
    expect(late).toHaveLength(1);
    expect(late[0].date).toBe("2026-11-05");
  });
});

describe("cursor codec", () => {
  it("round-trips and rejects a cursor from another filter set (INVALID_CURSOR)", () => {
    const c = encodeCursor({ t: "2026-11-05T10:00:00.000Z", i: "abc", f: "all||" });
    expect(decodeCursor(c, "all||")).toEqual({ t: "2026-11-05T10:00:00.000Z", i: "abc", f: "all||" });
    expect(() => decodeCursor(c, "unread||")).toThrowError(/cursor/i);
    expect(() => decodeCursor("garbage", "all||")).toThrowError();
    try { decodeCursor("garbage", "x"); } catch (e) { expect((e as { code: string }).code).toBe("INVALID_CURSOR"); }
  });
});

describe("registry, categories and locking (D-03, D-07, D-27)", () => {
  it("Admin has the six approved categories, Cashier exactly five", () => {
    expect(ADMIN_CATEGORIES.map((c) => categorySlug("ADMIN", c))).toEqual(["inventory", "cashier", "credit", "sales_purchases", "security", "daily_summary"]);
    expect(CASHIER_CATEGORIES.map((c) => categorySlug("CASHIER", c))).toEqual(["inventory", "account_security", "session", "announcement", "credit"]);
    expect(categoryFromSlug("ADMIN", "nope")).toBeUndefined();
    expect(categoryFromSlug("CASHIER", "sales_purchases")).toBeUndefined();
  });
  it("Security categories are locked", () => {
    expect(LOCKED_CATEGORIES.has("SECURITY")).toBe(true);
    expect(LOCKED_CATEGORIES.has("ACCOUNT_SECURITY")).toBe(true);
    expect(LOCKED_CATEGORIES.has("INVENTORY")).toBe(false);
  });
  it("every type used by an audience maps to a category that audience can see", () => {
    for (const [type, def] of Object.entries(TYPES) as unknown as [string, { admin?: { category: NtfCategory }; cashier?: { category: NtfCategory } }][]) {
      if (def.admin) expect(ADMIN_CATEGORIES, type).toContain(def.admin.category);
      if (def.cashier) expect(CASHIER_CATEGORIES, type).toContain(def.cashier.category);
    }
  });
  it("transaction alerts are Admin-only; Cashier type names match the Cashier contract", () => {
    expect("cashier" in TYPES["sales.high_value"]).toBe(false);
    expect("cashier" in TYPES["credit.large_sale"]).toBe(false);
    expect(cashierApiType("inventory.low_stock")).toBe("low_stock");
    expect(cashierApiType("cash.mismatch")).toBe("cash_mismatch");
    expect(cashierApiType("credit.overdue")).toBe("credit_overdue");
    expect(cashierApiType("announcement.published")).toBe("announcement");
  });
  it("approved defaults", () => {
    expect(NOTIFICATION_DEFAULTS.highValueSaleThreshold).toBe(5000);
    expect(NOTIFICATION_DEFAULTS.largeCreditThreshold).toBe(10000);
    expect(NOTIFICATION_DEFAULTS.cashMismatchTolerance).toBe(0);
    expect(NOTIFICATION_DEFAULTS.failedLogin).toEqual({ attempts: 5, windowMinutes: 10 });
    expect(NOTIFICATION_DEFAULTS.retentionDays).toBe(90);
  });
  it("90-day expiry and dedupe-key composition", () => {
    const t = new Date("2026-11-05T00:00:00Z");
    expect(computeExpiry(t).toISOString()).toBe("2027-02-03T00:00:00.000Z");
    expect(composeDedupeKey("ADMIN", "sales.high_value", "bill:1")).not.toBe(composeDedupeKey("CASHIER", "sales.high_value", "bill:1"));
  });
});

describe("scheduler watermark rules", () => {
  const now = new Date("2026-11-05T10:00:00Z");
  const wm = { key: "k", intervalMs: 1, watermarked: true, run: async () => ({ examined: 0, created: 0 }) };
  it("normal run moves the cursor to now − overlap; non-watermarked jobs keep none", () => {
    expect(nextCursor(wm, { examined: 1, created: 0 }, now)!.getTime()).toBe(now.getTime() - NOTIFICATION_DEFAULTS.sweepOverlapMs);
    expect(nextCursor({ ...wm, watermarked: false }, { examined: 1, created: 0 }, now)).toBeUndefined();
  });
  it("a capped run or a failing row holds the cursor back (restart/outage recovery)", () => {
    const from = new Date("2026-11-05T09:00:00Z");
    expect(nextCursor(wm, { examined: 1, created: 0, resumeFrom: from }, now)).toEqual(from);
    expect(nextCursor(wm, { examined: 1, created: 0, failures: 1, resumeFrom: from }, now)).toEqual(from);
  });
  it("a poison row older than 24h stops pinning the watermark", () => {
    const old = new Date("2026-11-03T09:00:00Z");
    expect(nextCursor(wm, { examined: 1, created: 0, failures: 1, resumeFrom: old }, now)!.getTime()).toBe(now.getTime() - NOTIFICATION_DEFAULTS.sweepOverlapMs);
  });
});
