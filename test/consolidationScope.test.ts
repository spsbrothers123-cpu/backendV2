import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the only DB-touching dependency so scope rules can be unit-tested.
vi.mock("../src/lib/shopAccess.js", () => ({ listShopsForAdmin: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import { listShopsForAdmin } from "../src/lib/shopAccess.js";
import {
  addDaysYmd,
  daysInPeriod,
  endOfBusinessDay,
  resolveConsolidationPeriod,
  resolveConsolidationScope,
  startOfBusinessDay,
  ymdInBusinessTime,
} from "../src/lib/consolidationScope.js";
import { productGroupKey } from "../src/services/consolidationService.js";

const shop = (id: string) => ({ id, name: `Shop ${id}`, code: id.toUpperCase() }) as never;

describe("resolveConsolidationScope", () => {
  beforeEach(() => vi.mocked(listShopsForAdmin).mockResolvedValue([shop("s1"), shop("s2"), shop("s3")]));

  it("defaults to every authorized shop (All Shops)", async () => {
    for (const p of [undefined, "", "all", "ALL"]) {
      const s = await resolveConsolidationScope("admin-1", p);
      expect(s.shops.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
      expect(s.selectedShopId).toBeNull();
    }
    expect(listShopsForAdmin).toHaveBeenCalledWith("admin-1");
  });

  it("narrows to a single owned shop independent of any global selection", async () => {
    const s = await resolveConsolidationScope("admin-1", "s2");
    expect(s.shops.map((x) => x.id)).toEqual(["s2"]);
    expect(s.selectedShopId).toBe("s2");
  });

  it("rejects a shop the admin does not own", async () => {
    await expect(resolveConsolidationScope("admin-1", "other-admins-shop")).rejects.toMatchObject({ statusCode: 403, code: "SHOP_ACCESS_DENIED" });
  });

  it("returns an empty scope (not an error) for an admin with no shops", async () => {
    vi.mocked(listShopsForAdmin).mockResolvedValue([]);
    expect((await resolveConsolidationScope("admin-1")).shops).toEqual([]);
  });
});

describe("business-local date handling (+05:30)", () => {
  // 2026-10-17 20:00 UTC == 2026-10-18 01:30 IST → "today" is the 18th, not the 17th.
  const now = new Date("2026-10-17T20:00:00Z");

  it("computes presets on the business calendar, not the server clock", () => {
    expect(ymdInBusinessTime(now, 330)).toBe("2026-10-18");
    const t = resolveConsolidationPeriod({ range: "today" }, now, 330);
    expect([t.fromYmd, t.toYmd]).toEqual(["2026-10-18", "2026-10-18"]);
    const y = resolveConsolidationPeriod({ range: "yesterday" }, now, 330);
    expect([y.fromYmd, y.toYmd]).toEqual(["2026-10-17", "2026-10-17"]);
    const w = resolveConsolidationPeriod({ range: "last7" }, now, 330);
    expect([w.fromYmd, w.toYmd]).toEqual(["2026-10-12", "2026-10-18"]);
    expect(daysInPeriod(w)).toHaveLength(7);
    const m = resolveConsolidationPeriod({ range: "last30" }, now, 330);
    expect(daysInPeriod(m)).toHaveLength(30);
  });

  it("day boundaries are exact: IST midnight to 23:59:59.999", () => {
    expect(startOfBusinessDay("2026-10-17", 330).toISOString()).toBe("2026-10-16T18:30:00.000Z");
    expect(endOfBusinessDay("2026-10-17", 330).toISOString()).toBe("2026-10-17T18:29:59.999Z");
  });

  it("defaults to last 7 days; infers custom when both dates are present", () => {
    expect(resolveConsolidationPeriod({}, now, 330).range).toBe("last7");
    expect(resolveConsolidationPeriod({ dateFrom: "2026-10-01", dateTo: "2026-10-05" }, now, 330).range).toBe("custom");
  });

  it("validates custom ranges", () => {
    const bad = (i: object) => expect(() => resolveConsolidationPeriod({ range: "custom", ...i }, now, 330)).toThrow();
    bad({});
    bad({ dateFrom: "2026-10-01" });
    bad({ dateFrom: "2026-13-01", dateTo: "2026-13-02" });
    bad({ dateFrom: "2026-10-05", dateTo: "2026-10-01" });
    bad({ dateFrom: "2024-01-01", dateTo: "2026-01-01" });
  });

  it("addDaysYmd crosses month boundaries", () => {
    expect(addDaysYmd("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysYmd("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("productGroupKey — never groups by name alone", () => {
  const base = { name: "Egg", category: "Eggs", sku: null, barcode: null, unit: "TRAY" };
  it("prefers barcode, then sku, then name+category+unit", () => {
    expect(productGroupKey({ ...base, barcode: " 8901 ", sku: "X" })).toEqual({ key: "bc:8901|TRAY", matchedBy: "barcode" });
    expect(productGroupKey({ ...base, sku: "EGG-1" })).toEqual({ key: "sku:egg-1|TRAY", matchedBy: "sku" });
    expect(productGroupKey(base).matchedBy).toBe("name");
  });
  it("same name but different unit or category stays separate", () => {
    expect(productGroupKey(base).key).not.toBe(productGroupKey({ ...base, unit: "PIECE" }).key);
    expect(productGroupKey(base).key).not.toBe(productGroupKey({ ...base, category: "Premium" }).key);
  });
  it("is case/whitespace-insensitive for the same product across shops", () => {
    expect(productGroupKey(base).key).toBe(productGroupKey({ ...base, name: "  egg ", category: "EGGS" }).key);
  });
});
