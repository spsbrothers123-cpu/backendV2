import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  product: { findMany: vi.fn() },
  branchProduct: { findMany: vi.fn() },
  bill: { findMany: vi.fn(), groupBy: vi.fn() },
  purchase: { findMany: vi.fn() },
  expense: { findMany: vi.fn() },
  customer: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
}));
vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));

import { resolveConsolidationPeriod } from "../src/lib/consolidationScope.js";
import {
  buildConsolidationExportPayload,
  getCustomers,
  getLowStock,
  getProductStock,
  getSales,
} from "../src/services/consolidationService.js";
import { buildReportExcelBuffer, buildReportPdfBuffer } from "../src/services/exportService.js";

const shops = [
  { id: "s1", name: "Shop 1", code: "S1" },
  { id: "s2", name: "Shop 2", code: "S2" },
  { id: "s3", name: "Shop 3", code: "S3" },
];
const period = resolveConsolidationPeriod({ range: "custom", dateFrom: "2026-10-01", dateTo: "2026-10-03" }, new Date("2026-10-17T00:00:00Z"), 330);
const egg = (shopId: string, stock: number, extra = {}) => ({ shopId, name: "Egg", category: "Eggs", sku: null, barcode: "8901", unit: "TRAY", stock, id: `p-${shopId}`, lowStockThreshold: 20, ...extra });

// Mirrors BranchProduct: one assigned row per (shop, product). egg() ids are `p-${shopId}`.
const assigned = (...shopIds: string[]) =>
  db.branchProduct.findMany.mockResolvedValue(
    shopIds.map((shopId) => ({ shopId, productId: `p-${shopId}`, isAssigned: true, priceOverride: null })),
  );

beforeEach(() => {
  vi.clearAllMocks();
  // assignedBranchStock calls prisma.branchProduct.findMany; default to no branch rows.
  // Tests that need branch rows can override with their own mockResolvedValue([...]),
  // e.g. via the assigned(...shopIds) helper above.
  db.branchProduct.findMany.mockResolvedValue([]);
});

describe("getProductStock", () => {
  it("sums per-shop stock exactly, keeps non-carrying shops null, and never uses date params", async () => {
    assigned("s1", "s2", "s3");
    db.product.findMany.mockResolvedValue([
      egg("s1", 50), egg("s2", 60), egg("s3", 80),
      { ...egg("s1", 7), barcode: null, name: "Feed", category: "Supplies", unit: "KG" },
      { ...egg("s3", 0), barcode: null, name: "Feed", category: "Supplies", unit: "KG" },
      { ...egg("s2", 9), unit: "PIECE" }, // same barcode, different unit → separate row
    ]);
    const r = await getProductStock(shops, { page: 1, pageSize: 20 });
    const trayEgg = r.rows.find((x) => x.unit === "tray")!;
    expect(trayEgg.totalStock).toBe(190);
    expect(trayEgg.perShop).toEqual({ s1: 50, s2: 60, s3: 80 });
    const feed = r.rows.find((x) => x.name === "Feed")!;
    expect(feed.perShop).toEqual({ s1: 7, s2: null, s3: 0 });
    expect(r.rows.find((x) => x.unit === "piece")!.totalStock).toBe(9);
    // the query is shop-scoped to the authorized list and ACTIVE only
    expect(db.product.findMany.mock.calls[0][0].where).toEqual({ shopId: { in: ["s1", "s2", "s3"] }, status: "ACTIVE" });
  });

  it("empty scope returns an empty result without querying", async () => {
    const r = await getProductStock([], { page: 1, pageSize: 20 });
    expect(r.rows).toEqual([]);
    expect(db.product.findMany).not.toHaveBeenCalled();
  });
});

describe("getLowStock", () => {
  it("reuses the inventory-alert rules (<= threshold, 0 = Critical)", async () => {
    assigned("s1", "s2", "s3");
    db.product.findMany.mockResolvedValue([egg("s1", 50), egg("s2", 4), egg("s3", 0)]);
    const r = await getLowStock(shops, { page: 1, pageSize: 20 });
    expect(r.rows.map((x) => [x.shopId, x.status, x.available, x.threshold])).toEqual([["s3", "Critical", 0, 20], ["s2", "Low Stock", 4, 20]]);
  });
});

describe("getSales", () => {
  it("computes shop totals, contribution %, includes zero shops, fills trend days", async () => {
    db.bill.findMany.mockResolvedValue([
      { shopId: "s1", grandTotal: 300, createdAt: new Date("2026-10-01T05:00:00Z") },
      { shopId: "s2", grandTotal: 700, createdAt: new Date("2026-10-02T05:00:00Z") },
    ]);
    const r = await getSales(shops, period);
    expect(r.totalSales).toBe(1000);
    expect(r.totalBills).toBe(2);
    expect(r.shops.map((s) => [s.shopId, s.salesAmount, s.completedBills, s.contributionPct])).toEqual([["s1", 300, 1, 30], ["s2", 700, 1, 70], ["s3", 0, 0, 0]]);
    expect(r.trend.map((t) => t.total)).toEqual([300, 700, 0]);
    expect(db.bill.findMany.mock.calls[0][0].where.status).toBe("PAID");
  });
});

describe("getCustomers", () => {
  it("keeps same-phone customers in two shops as two rows; credit is current, purchases are windowed", async () => {
    db.customer.groupBy.mockResolvedValue([]);
    db.customer.count.mockResolvedValue(2);
    db.customer.findMany.mockResolvedValue([
      { id: "c1", name: "Ravi", phone: "900", shopId: "s1", creditBalance: 300 },
      { id: "c2", name: "Ravi", phone: "900", shopId: "s2", creditBalance: 0 },
    ]);
    db.bill.groupBy.mockResolvedValue([{ customerId: "c1", _count: { _all: 3 }, _sum: { grandTotal: 900 } }]);
    const r = await getCustomers(shops, period, { page: 1, pageSize: 20 });
    expect(r.rows.map((x) => [x.id, x.shopName, x.purchaseCount, x.purchaseTotal, x.outstandingCredit])).toEqual([["c1", "Shop 1", 3, 900, 300], ["c2", "Shop 2", 0, 0, 0]]);
    expect(db.bill.groupBy).toHaveBeenCalledTimes(1); // no N+1
  });
});

describe("export", () => {
  it("full report payload carries period + generated-at + live-stock note and renders real xlsx/pdf", async () => {
    db.product.findMany.mockResolvedValue([egg("s1", 50), egg("s2", 60)]);
    db.bill.findMany.mockResolvedValue([]); db.purchase.findMany.mockResolvedValue([]); db.expense.findMany.mockResolvedValue([]);
    db.customer.groupBy.mockResolvedValue([]); db.customer.count.mockResolvedValue(0); db.customer.findMany.mockResolvedValue([]); db.bill.groupBy.mockResolvedValue([]);
    const { title, payload } = await buildConsolidationExportPayload({ scope: "full", shops, selectedShopId: null, period });
    const labels = payload.summary.map((r) => r.label);
    expect(labels).toEqual(expect.arrayContaining(["Shops", "Reporting Period", "Generated At"]));
    expect(payload.summary.find((r) => r.label.includes("Stock Basis"))!.value).toMatch(/Live snapshot/);
    const names = (payload.tables ?? []).map((t) => t.title.slice(0, 31));
    expect(new Set(names).size).toBe(names.length); // Excel sheet names must be unique
    const xlsx = await buildReportExcelBuffer(payload);
    expect(xlsx.subarray(0, 2).toString()).toBe("PK");
    const pdf = await buildReportPdfBuffer(title, "x", payload);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
