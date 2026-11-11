import { prisma } from "../lib/prisma.js";
import { toNumber } from "../lib/money.js";
import { productStatusLabel } from "../lib/serializeAdmin.js";
import {
  daysInPeriod,
  shortDayLabel,
  ymdInBusinessTime,
  type ConsolidationPeriod,
} from "../lib/consolidationScope.js";

/**
 * Read-only cross-shop aggregation for the Consolidation module.
 *
 * Every function takes the ALREADY-AUTHORIZED shop list produced by
 * resolveConsolidationScope() and filters strictly on those ids — nothing
 * here reads request.authUser.shopId (the global shop selector).
 *
 * Calculation rules deliberately mirror the existing admin reports/credits:
 *  - Sales: Bill.status = PAID, summed on grandTotal (reports.ts, dashboard.ts).
 *    The schema has no REFUNDED status; CANCELLED and HELD bills never count.
 *  - Purchases: Purchase.createdAt window, grandTotal (reports.ts); CANCELLED
 *    purchases are excluded here (reports.ts does not filter status, but the
 *    app only ever creates RECEIVED purchases today, so totals agree).
 *  - Expenses: Expense.date window, amount (reports.ts).
 *  - Credit: Customer.creditBalance > 0 (credits.ts /summary).
 *  - Stock: Product.stock, the denormalized sum of that shop's CashierInventory
 *    rows (live), ACTIVE products only, threshold logic = productStatusLabel.
 */

// ── Types ───────────────────────────────────────────────────────────────

export type ScopeShop = { id: string; name: string };

export type ConsolidationSection =
  | "overview"
  | "sales"
  | "products"
  | "customers"
  | "purchases"
  | "expenses"
  | "low-stock";

export type PageOpts = { search?: string; page: number; pageSize: number | null };

type SummaryRow = { label: string; value: string };
type ExportColumn = { key: string; header: string; width?: number };
type ExportTable = { title: string; columns: ExportColumn[]; rows: Record<string, unknown>[] };
type SectionParts = { summary: SummaryRow[]; tables: ExportTable[] };

export type ConsolidationExportPayload = { summary: SummaryRow[]; tables?: ExportTable[] };

// ── Helpers ─────────────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct1 = (n: number) => Math.round(n * 10) / 10;

const ids = (shops: ScopeShop[]) => shops.map((s) => s.id);
const nameOf = (shops: ScopeShop[]) => new Map(shops.map((s) => [s.id, s.name]));

// ── Sales ───────────────────────────────────────────────────────────────

export async function getSales(shops: ScopeShop[], period: ConsolidationPeriod) {
  const bills = shops.length
    ? await prisma.bill.findMany({
        where: { shopId: { in: ids(shops) }, status: "PAID", createdAt: { gte: period.from, lte: period.to } },
        select: { shopId: true, grandTotal: true, createdAt: true },
      })
    : [];

  const perShop = new Map(shops.map((s) => [s.id, { amount: 0, bills: 0 }]));
  const perDay = new Map<string, { total: number; perShop: Record<string, number> }>();
  for (const day of daysInPeriod(period)) perDay.set(day, { total: 0, perShop: {} });

  for (const b of bills) {
    const amt = toNumber(b.grandTotal);
    const s = perShop.get(b.shopId)!;
    s.amount += amt;
    s.bills += 1;
    const day = perDay.get(ymdInBusinessTime(b.createdAt));
    if (day) {
      day.total += amt;
      day.perShop[b.shopId] = (day.perShop[b.shopId] ?? 0) + amt;
    }
  }

  const totalSales = [...perShop.values()].reduce((a, s) => a + s.amount, 0);
  const totalBills = bills.length;

  return {
    totalSales: round2(totalSales),
    totalBills,
    shops: shops.map((sh) => {
      const s = perShop.get(sh.id)!;
      return {
        shopId: sh.id,
        shopName: sh.name,
        salesAmount: round2(s.amount),
        completedBills: s.bills,
        contributionPct: totalSales > 0 ? pct1((s.amount / totalSales) * 100) : 0,
      };
    }),
    trend: [...perDay.entries()].map(([date, v]) => ({
      date,
      label: shortDayLabel(date),
      total: round2(v.total),
      perShop: Object.fromEntries(Object.entries(v.perShop).map(([k, n]) => [k, round2(n)])) as Record<string, number>,
    })),
  };
}

// ── Purchases ───────────────────────────────────────────────────────────

export async function getPurchases(shops: ScopeShop[], period: ConsolidationPeriod) {
  const rows = shops.length
    ? await prisma.purchase.findMany({
        where: {
          shopId: { in: ids(shops) },
          status: { not: "CANCELLED" },
          createdAt: { gte: period.from, lte: period.to },
        },
        select: { shopId: true, grandTotal: true, createdAt: true },
      })
    : [];

  const byShop = new Map(shops.map((s) => [s.id, { amount: 0, count: 0 }]));
  const byDate = new Map<string, { total: number; count: number }>();
  for (const day of daysInPeriod(period)) byDate.set(day, { total: 0, count: 0 });

  let total = 0;
  for (const p of rows) {
    const amt = toNumber(p.grandTotal);
    total += amt;
    const s = byShop.get(p.shopId)!;
    s.amount += amt;
    s.count += 1;
    const d = byDate.get(ymdInBusinessTime(p.createdAt));
    if (d) {
      d.total += amt;
      d.count += 1;
    }
  }

  return {
    total: round2(total),
    count: rows.length,
    byShop: shops.map((sh) => ({ shopId: sh.id, shopName: sh.name, amount: round2(byShop.get(sh.id)!.amount), count: byShop.get(sh.id)!.count })),
    byDate: [...byDate.entries()].map(([date, v]) => ({ date, label: shortDayLabel(date), total: round2(v.total), count: v.count })),
  };
}

// ── Expenses ────────────────────────────────────────────────────────────

export async function getExpenses(shops: ScopeShop[], period: ConsolidationPeriod) {
  const rows = shops.length
    ? await prisma.expense.findMany({
        where: { shopId: { in: ids(shops) }, date: { gte: period.from, lte: period.to } },
        select: { shopId: true, amount: true, date: true, category: true },
      })
    : [];

  const byShop = new Map(shops.map((s) => [s.id, { amount: 0, count: 0 }]));
  const byDate = new Map<string, { total: number; count: number }>();
  for (const day of daysInPeriod(period)) byDate.set(day, { total: 0, count: 0 });
  const byCategory = new Map<string, { amount: number; count: number }>();

  let total = 0;
  for (const e of rows) {
    const amt = toNumber(e.amount);
    total += amt;
    const s = byShop.get(e.shopId)!;
    s.amount += amt;
    s.count += 1;
    const d = byDate.get(ymdInBusinessTime(e.date));
    if (d) {
      d.total += amt;
      d.count += 1;
    }
    const c = byCategory.get(e.category) ?? { amount: 0, count: 0 };
    c.amount += amt;
    c.count += 1;
    byCategory.set(e.category, c);
  }

  return {
    total: round2(total),
    count: rows.length,
    byShop: shops.map((sh) => ({ shopId: sh.id, shopName: sh.name, amount: round2(byShop.get(sh.id)!.amount), count: byShop.get(sh.id)!.count })),
    byDate: [...byDate.entries()].map(([date, v]) => ({ date, label: shortDayLabel(date), total: round2(v.total), count: v.count })),
    byCategory: [...byCategory.entries()]
      .map(([category, v]) => ({ category, amount: round2(v.amount), count: v.count }))
      .sort((a, b) => b.amount - a.amount),
  };
}

// ── Products & stock (LIVE) ─────────────────────────────────────────────

export type ProductMatchedBy = "barcode" | "sku" | "name";

/**
 * Cross-shop product identity. Product rows are per-shop (Product.shopId) and
 * the schema has no shared catalogue id, so identity is derived, strongest
 * signal first — never by name alone:
 *   1. barcode (+ unit)           → "bc:<barcode>|<UNIT>"
 *   2. sku (+ unit)               → "sku:<sku>|<UNIT>"
 *   3. name + category + unit     → "nm:<name>|<category>|<UNIT>"
 * Unit is always part of the key so kg/tray/piece variants never merge.
 */
export function productGroupKey(p: {
  name: string;
  category: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
}): { key: string; matchedBy: ProductMatchedBy } {
  const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
  const barcode = p.barcode?.trim();
  if (barcode) return { key: `bc:${norm(barcode)}|${p.unit}`, matchedBy: "barcode" };
  const sku = p.sku?.trim();
  if (sku) return { key: `sku:${norm(sku)}|${p.unit}`, matchedBy: "sku" };
  return { key: `nm:${norm(p.name)}|${norm(p.category)}|${p.unit}`, matchedBy: "name" };
}

export async function getProductStock(shops: ScopeShop[], opts: PageOpts) {
  const products = shops.length
    ? await prisma.product.findMany({
        where: { shopId: { in: ids(shops) }, status: "ACTIVE" },
        select: { shopId: true, name: true, category: true, sku: true, barcode: true, unit: true, stock: true },
      })
    : [];

  type Group = {
    key: string;
    matchedBy: ProductMatchedBy;
    name: string;
    category: string;
    unit: string;
    perShop: Record<string, number | null>;
    totalStock: number;
  };
  const groups = new Map<string, Group>();
  for (const p of products) {
    const { key, matchedBy } = productGroupKey(p);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        matchedBy,
        name: p.name,
        category: p.category,
        unit: p.unit.toLowerCase(),
        perShop: Object.fromEntries(shops.map((s) => [s.id, null])) as Record<string, number | null>,
        totalStock: 0,
      };
      groups.set(key, g);
    }
    // Two active rows for one key inside the same shop (e.g. duplicate names)
    // are summed rather than overwritten, so totals stay exact.
    g.perShop[p.shopId] = (g.perShop[p.shopId] ?? 0) + p.stock;
    g.totalStock += p.stock;
  }

  const q = opts.search?.trim().toLowerCase();
  let rows = [...groups.values()]
    .filter((g) => !q || g.name.toLowerCase().includes(q) || g.category.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name) || a.unit.localeCompare(b.unit))
    .map((g) => ({
      key: g.key,
      matchedBy: g.matchedBy,
      name: g.name,
      variant: null as string | null,
      category: g.category,
      unit: g.unit,
      totalStock: g.totalStock,
      perShop: g.perShop,
    }));

  const total = rows.length;
  if (opts.pageSize !== null) rows = rows.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize);

  return {
    shops: shops.map((s) => ({ id: s.id, name: s.name })),
    rows,
    page: opts.page,
    pageSize: opts.pageSize ?? total,
    total,
    note: "Stock data always reflects current live inventory and is not affected by the date filter.",
  };
}

// ── Low stock (LIVE) ────────────────────────────────────────────────────

export async function getLowStock(shops: ScopeShop[], opts: PageOpts) {
  const products = shops.length
    ? await prisma.product.findMany({
        where: { shopId: { in: ids(shops) }, status: "ACTIVE" },
        select: { id: true, shopId: true, name: true, unit: true, stock: true, lowStockThreshold: true },
      })
    : [];

  const names = nameOf(shops);
  const q = opts.search?.trim().toLowerCase();
  let rows = products
    .filter((p) => productStatusLabel(p) !== "In Stock")
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name))
    .map((p) => ({
      id: p.id,
      productName: p.name,
      unit: p.unit.toLowerCase(),
      shopId: p.shopId,
      shopName: names.get(p.shopId) ?? "",
      available: p.stock,
      threshold: p.lowStockThreshold,
      // Same labels as GET /api/admin/inventory/alerts
      status: p.stock <= 0 ? "Critical" : "Low Stock",
    }));

  const total = rows.length;
  if (opts.pageSize !== null) rows = rows.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize);

  return { rows, page: opts.page, pageSize: opts.pageSize ?? total, total };
}

// ── Customers & credit ──────────────────────────────────────────────────

export async function getCreditSummary(shops: ScopeShop[]) {
  if (!shops.length) {
    return { totalOutstanding: 0, customersWithCredit: 0, totalCustomers: 0, byShop: [] as { shopId: string; shopName: string; outstanding: number }[] };
  }
  const where = { shopId: { in: ids(shops) } };
  const [owing, all] = await Promise.all([
    prisma.customer.groupBy({ by: ["shopId"], where: { ...where, creditBalance: { gt: 0 } }, _sum: { creditBalance: true }, _count: { _all: true } }),
    prisma.customer.groupBy({ by: ["shopId"], where, _count: { _all: true } }),
  ]);
  const owingBy = new Map(owing.map((r) => [r.shopId, r]));
  const byShop = shops.map((s) => ({
    shopId: s.id,
    shopName: s.name,
    outstanding: round2(toNumber(owingBy.get(s.id)?._sum.creditBalance)),
  }));
  return {
    totalOutstanding: round2(byShop.reduce((a, s) => a + s.outstanding, 0)),
    customersWithCredit: owing.reduce((a, r) => a + r._count._all, 0),
    totalCustomers: all.reduce((a, r) => a + r._count._all, 0),
    byShop,
  };
}

/**
 * Branch-specific customer records — the same person in two shops (or under
 * two cashiers) stays as separate rows; nothing is merged. Purchase count /
 * total honour the date window; outstandingCredit is always the CURRENT
 * balance.
 */
export async function getCustomers(shops: ScopeShop[], period: ConsolidationPeriod, opts: PageOpts) {
  const summary = await getCreditSummary(shops);
  if (!shops.length) return { summary, page: opts.page, pageSize: opts.pageSize ?? 0, total: 0, rows: [] };

  const q = opts.search?.trim();
  const where = {
    shopId: { in: ids(shops) },
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }] } : {}),
  };

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [{ creditBalance: "desc" }, { name: "asc" }, { id: "asc" }],
      ...(opts.pageSize !== null ? { skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize } : {}),
      select: { id: true, name: true, phone: true, shopId: true, creditBalance: true },
    }),
    prisma.customer.count({ where }),
  ]);

  // One grouped query for the whole page — no per-customer round trips.
  const stats = customers.length
    ? await prisma.bill.groupBy({
        by: ["customerId"],
        where: {
          customerId: { in: customers.map((c) => c.id) },
          shopId: { in: ids(shops) },
          status: "PAID",
          createdAt: { gte: period.from, lte: period.to },
        },
        _count: { _all: true },
        _sum: { grandTotal: true },
      })
    : [];
  const statBy = new Map(stats.map((s) => [s.customerId, s]));
  const names = nameOf(shops);

  return {
    summary,
    page: opts.page,
    pageSize: opts.pageSize ?? total,
    total,
    rows: customers.map((c) => ({
      id: c.id,
      name: c.name,
      phone: c.phone,
      shopId: c.shopId,
      shopName: names.get(c.shopId) ?? "",
      purchaseCount: statBy.get(c.id)?._count._all ?? 0,
      purchaseTotal: round2(toNumber(statBy.get(c.id)?._sum.grandTotal)),
      outstandingCredit: round2(toNumber(c.creditBalance)),
    })),
  };
}

// ── Overview ────────────────────────────────────────────────────────────

export async function getOverview(shops: ScopeShop[], period: ConsolidationPeriod) {
  const [sales, purchases, expenses, stock, low, credits] = await Promise.all([
    getSales(shops, period),
    getPurchases(shops, period),
    getExpenses(shops, period),
    getProductStock(shops, { page: 1, pageSize: 8 }),
    getLowStock(shops, { page: 1, pageSize: 5 }),
    getCreditSummary(shops),
  ]);
  return {
    totalSales: sales.totalSales,
    totalPurchases: purchases.total,
    totalExpenses: expenses.total,
    activeShops: shops.length,
    shopSales: sales.shops,
    stockPreview: { shops: stock.shops, rows: stock.rows },
    lowStockPreview: low.rows,
    lowStockTotal: low.total,
    credits,
    purchaseSummary: { total: purchases.total, count: purchases.count },
    expenseSummary: { total: expenses.total, count: expenses.count },
  };
}

// ── Export payload ──────────────────────────────────────────────────────

export const CONSOLIDATION_SECTIONS: ConsolidationSection[] = ["overview", "sales", "products", "customers", "purchases", "expenses", "low-stock"];

export const SECTION_TITLE: Record<ConsolidationSection, string> = {
  overview: "Overview",
  sales: "Shops and Sales",
  products: "Products and Stock",
  customers: "Customers and Credits",
  purchases: "Purchases",
  expenses: "Expenses",
  "low-stock": "Low Stock Alerts",
};

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ALL: PageOpts = { page: 1, pageSize: null };

/** Section is live (not date-filtered) → period is irrelevant to it. */
export const LIVE_SECTIONS: ConsolidationSection[] = ["products", "low-stock"];

async function sectionTables(section: ConsolidationSection, shops: ScopeShop[], period: ConsolidationPeriod): Promise<SectionParts> {
  switch (section) {
    case "overview": {
      const [sales, purchases, expenses, credits, low] = await Promise.all([
        getSales(shops, period), getPurchases(shops, period), getExpenses(shops, period), getCreditSummary(shops), getLowStock(shops, { page: 1, pageSize: 1 }),
      ]);
      return {
        summary: [
          { label: "Total Sales", value: inr(sales.totalSales) },
          { label: "Total Purchases", value: inr(purchases.total) },
          { label: "Total Expenses", value: inr(expenses.total) },
          { label: "Active Shops", value: String(shops.length) },
          { label: "Outstanding Credit (current)", value: inr(credits.totalOutstanding) },
          { label: "Low Stock Items (current)", value: String(low.total) },
        ],
        tables: [{
          title: "Shop Summary",
          columns: [{ key: "shop", header: "Shop", width: 28 }, { key: "sales", header: "Sales", width: 16 }, { key: "bills", header: "Bills", width: 10 }, { key: "purchases", header: "Purchases", width: 16 }, { key: "expenses", header: "Expenses", width: 16 }, { key: "credit", header: "Outstanding Credit", width: 20 }],
          rows: shops.map((s, i) => ({
            shop: s.name,
            sales: sales.shops[i].salesAmount,
            bills: sales.shops[i].completedBills,
            purchases: purchases.byShop[i].amount,
            expenses: expenses.byShop[i].amount,
            credit: credits.byShop[i].outstanding,
          })),
        }],
      };
    }
    case "sales": {
      const s = await getSales(shops, period);
      return {
        summary: [{ label: "Total Sales", value: inr(s.totalSales) }, { label: "Completed Bills", value: String(s.totalBills) }],
        tables: [
          { title: "Shop Sales", columns: [{ key: "shopName", header: "Shop", width: 28 }, { key: "salesAmount", header: "Sales", width: 16 }, { key: "completedBills", header: "Completed Bills", width: 16 }, { key: "contributionPct", header: "Contribution %", width: 16 }], rows: s.shops },
          { title: "Daily Sales", columns: [{ key: "date", header: "Date", width: 14 }, { key: "total", header: "Sales", width: 16 }], rows: s.trend },
        ],
      };
    }
    case "products": {
      const p = await getProductStock(shops, ALL);
      const columns: ExportColumn[] = [
        { key: "name", header: "Product", width: 28 }, { key: "category", header: "Category", width: 16 }, { key: "unit", header: "Unit", width: 8 }, { key: "total", header: "Total Stock", width: 12 },
        ...shops.map((s, i) => ({ key: `s${i}`, header: s.name, width: 16 })),
      ];
      return {
        summary: [{ label: "Distinct Products", value: String(p.total) }, { label: "Stock Basis", value: "Live snapshot at generation time (not historical, not date-filtered)" }],
        tables: [{
          title: "Stock Distribution",
          columns,
          rows: p.rows.map((r) => ({
            name: r.name, category: r.category, unit: r.unit, total: r.totalStock,
            ...Object.fromEntries(shops.map((s, i) => [`s${i}`, r.perShop[s.id] ?? "Not carried"])),
          })),
        }],
      };
    }
    case "customers": {
      const c = await getCustomers(shops, period, ALL);
      return {
        summary: [
          { label: "Total Outstanding Credit (current)", value: inr(c.summary.totalOutstanding) },
          { label: "Customers With Credit", value: String(c.summary.customersWithCredit) },
          { label: "Total Customer Records", value: String(c.summary.totalCustomers) },
        ],
        tables: [{
          title: "Customers",
          columns: [{ key: "name", header: "Customer", width: 24 }, { key: "phone", header: "Phone", width: 16 }, { key: "shopName", header: "Shop", width: 24 }, { key: "purchaseCount", header: "Bills (period)", width: 14 }, { key: "purchaseTotal", header: "Purchases (period)", width: 18 }, { key: "outstandingCredit", header: "Outstanding Credit", width: 18 }],
          rows: c.rows,
        }],
      };
    }
    case "purchases": {
      const p = await getPurchases(shops, period);
      return {
        summary: [{ label: "Total Purchases", value: inr(p.total) }, { label: "Purchase Count", value: String(p.count) }],
        tables: [
          { title: "Purchases by Shop", columns: [{ key: "shopName", header: "Shop", width: 28 }, { key: "amount", header: "Amount", width: 16 }, { key: "count", header: "Count", width: 10 }], rows: p.byShop },
          { title: "Purchases by Date", columns: [{ key: "date", header: "Date", width: 14 }, { key: "total", header: "Amount", width: 16 }, { key: "count", header: "Count", width: 10 }], rows: p.byDate },
        ],
      };
    }
    case "expenses": {
      const e = await getExpenses(shops, period);
      return {
        summary: [{ label: "Total Expenses", value: inr(e.total) }, { label: "Expense Count", value: String(e.count) }],
        tables: [
          { title: "Expenses by Shop", columns: [{ key: "shopName", header: "Shop", width: 28 }, { key: "amount", header: "Amount", width: 16 }, { key: "count", header: "Count", width: 10 }], rows: e.byShop },
          { title: "Expenses by Category", columns: [{ key: "category", header: "Category", width: 24 }, { key: "amount", header: "Amount", width: 16 }, { key: "count", header: "Count", width: 10 }], rows: e.byCategory },
          { title: "Expenses by Date", columns: [{ key: "date", header: "Date", width: 14 }, { key: "total", header: "Amount", width: 16 }, { key: "count", header: "Count", width: 10 }], rows: e.byDate },
        ],
      };
    }
    case "low-stock": {
      const l = await getLowStock(shops, ALL);
      return {
        summary: [{ label: "Low / Out-of-Stock Items", value: String(l.total) }, { label: "Stock Basis", value: "Live snapshot at generation time" }],
        tables: [{
          title: "Low Stock Alerts",
          columns: [{ key: "productName", header: "Product", width: 28 }, { key: "shopName", header: "Shop", width: 24 }, { key: "available", header: "Current Stock", width: 14 }, { key: "threshold", header: "Minimum Threshold", width: 18 }, { key: "unit", header: "Unit", width: 8 }, { key: "status", header: "Status", width: 12 }],
          rows: l.rows,
        }],
      };
    }
  }
}

/** Header rows shared by every export: scope, period, generation time. */
function headerSummary(shops: ScopeShop[], selectedShopId: string | null | undefined, period: ConsolidationPeriod | null): SummaryRow[] {
  return [
    { label: "Shops", value: selectedShopId ? shops.map((s) => s.name).join(", ") : `All Shops (${shops.length})` },
    { label: "Reporting Period", value: period ? period.label : "Not applicable (live snapshot)" },
    { label: "Generated At", value: new Date().toISOString() },
  ];
}

export async function buildConsolidationExportPayload(args: {
  scope: "section" | "full";
  section?: ConsolidationSection;
  shops: ScopeShop[];
  selectedShopId?: string | null;
  period: ConsolidationPeriod | null;
}): Promise<{ title: string; payload: ConsolidationExportPayload }> {
  const { shops, selectedShopId, period } = args;
  const sections: ConsolidationSection[] = args.scope === "full" ? CONSOLIDATION_SECTIONS : [args.section!];
  const summary = headerSummary(shops, selectedShopId, period);
  const tables: ExportTable[] = [];

  for (const section of sections) {
    // Date-filtered sections need a period; live ones ignore it.
    const p = period ?? (LIVE_SECTIONS.includes(section) ? ({} as ConsolidationPeriod) : null);
    if (!p) continue;
    const part = await sectionTables(section, shops, p);
    if (args.scope === "section") summary.push(...part.summary);
    else summary.push(...part.summary.map((r) => ({ label: `${SECTION_TITLE[section]} – ${r.label}`, value: r.value })));
    tables.push(...part.tables.map((t) => ({ ...t, title: args.scope === "full" ? `${SECTION_TITLE[section]} · ${t.title}` : t.title })));
  }

  return {
    title: args.scope === "full" ? "Consolidation Report" : `Consolidation – ${SECTION_TITLE[args.section!]}`,
    payload: { summary, tables },
  };
}
