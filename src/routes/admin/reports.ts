import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { toNumber } from "../../lib/money.js";
import { resolveRange } from "../../lib/dateRange.js";
import { PAYMENT_LABEL } from "../../lib/serializeAdmin.js";
import {
  buildExportFilename,
  buildReportCsvBuffer,
  buildReportExcelBuffer,
  buildReportPdfBuffer,
  contentTypeFor,
  extensionFor,
  type ExportColumn,
  type ReportExportPayload,
} from "../../services/exportService.js";

const rangeQuerySchema = z.object({
  range: z.enum(["today", "week", "month", "custom"]).default("today"),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const exportQuerySchema = rangeQuerySchema.extend({
  type: z.enum(["sales", "purchases", "expenses", "profit"]),
  format: z.enum(["excel", "csv", "pdf"]).default("excel"),
});

function dailyTrend(entries: { date: Date; value: number }[]): { label: string; value: number }[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    const day = e.date.toISOString().slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + e.value);
  }
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, value]) => ({ label, value }));
}

function formatMoney(value: number): string {
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Shared data-fetch functions ────────────────────────────────────────
// Used by both the JSON report endpoints (GET /sales, /purchases, ...)
// and the export endpoint (GET /export), so the two can never drift.

async function getSalesReportData(shopId: string, range: string, dateFrom?: string, dateTo?: string) {
  const { from, to } = resolveRange(range, dateFrom, dateTo);

  const bills = await prisma.bill.findMany({
    where: { shopId, status: "PAID", createdAt: { gte: from, lte: to } },
    include: { payments: true },
  });

  const totalSales = bills.reduce((s, b) => s + toNumber(b.grandTotal), 0);
  const billCount = bills.length;
  const averageBillValue = billCount ? totalSales / billCount : 0;

  const methodTotals: Record<string, number> = { Cash: 0, UPI: 0, Card: 0, Credit: 0 };
  for (const b of bills) {
    for (const p of b.payments) methodTotals[PAYMENT_LABEL[p.method]] += toNumber(p.amount);
  }

  const salesTrend = dailyTrend(bills.map((b) => ({ date: b.createdAt, value: toNumber(b.grandTotal) })));

  return {
    totalSales,
    revenue: totalSales,
    billCount,
    averageBillValue,
    salesTrend,
    revenueTrend: salesTrend,
    paymentBreakdown: Object.entries(methodTotals).map(([label, value]) => ({ label, value })),
  };
}

async function getPurchaseReportData(shopId: string, range: string, dateFrom?: string, dateTo?: string) {
  const { from, to } = resolveRange(range, dateFrom, dateTo);

  const purchases = await prisma.purchase.findMany({
    where: { shopId, createdAt: { gte: from, lte: to } },
  });

  const purchaseCost = purchases.reduce((s, p) => s + toNumber(p.grandTotal), 0);
  const bySupplier = new Map<string, number>();
  for (const p of purchases) bySupplier.set(p.supplierName, (bySupplier.get(p.supplierName) ?? 0) + toNumber(p.grandTotal));
  const topSuppliers = [...bySupplier.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([label, value]) => ({ label, value }));
  const supplierDistribution = topSuppliers.map((s) => ({
    label: s.label,
    value: purchaseCost ? Math.round((s.value / purchaseCost) * 100) : 0,
  }));

  return {
    totalPurchases: purchases.length,
    purchaseCost,
    billCount: purchases.length,
    topSuppliers,
    purchaseTrend: dailyTrend(purchases.map((p) => ({ date: p.createdAt, value: toNumber(p.grandTotal) }))),
    supplierDistribution,
  };
}

async function getExpenseReportData(shopId: string, range: string, dateFrom?: string, dateTo?: string) {
  const { from, to } = resolveRange(range, dateFrom, dateTo);

  const expenses = await prisma.expense.findMany({
    where: { shopId, date: { gte: from, lte: to } },
  });

  const totalExpenses = expenses.reduce((s, e) => s + toNumber(e.amount), 0);
  const byCategory = new Map<string, number>();
  for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + toNumber(e.amount));
  const categoryBreakdown = [...byCategory.entries()].map(([label, value]) => ({ label, value }));
  const topCategory = categoryBreakdown.sort((a, b) => b.value - a.value)[0]?.label ?? "—";

  return {
    totalExpenses,
    topCategory,
    expenseTrend: dailyTrend(expenses.map((e) => ({ date: e.date, value: toNumber(e.amount) }))),
    categoryBreakdown,
  };
}

async function getProfitReportData(shopId: string, range: string, dateFrom?: string, dateTo?: string) {
  const { from, to } = resolveRange(range, dateFrom, dateTo);

  const [bills, purchases, expenses] = await Promise.all([
    prisma.bill.findMany({ where: { shopId, status: "PAID", createdAt: { gte: from, lte: to } } }),
    prisma.purchase.findMany({ where: { shopId, createdAt: { gte: from, lte: to } } }),
    prisma.expense.findMany({ where: { shopId, date: { gte: from, lte: to } } }),
  ]);

  const revenue = bills.reduce((s, b) => s + toNumber(b.grandTotal), 0);
  const purchaseCost = purchases.reduce((s, p) => s + toNumber(p.grandTotal), 0);
  const expensesTotal = expenses.reduce((s, e) => s + toNumber(e.amount), 0);

  return { revenue, purchaseCost, expenses: expensesTotal, estimatedProfit: revenue - purchaseCost - expensesTotal };
}

// ── Report → export-payload adapters ────────────────────────────────────
// Turns each report's JSON shape into the generic { summary, tables }
// shape exportService.ts knows how to render as Excel/CSV/PDF.

const trendColumns: ExportColumn[] = [{ key: "label", header: "Date" }, { key: "value", header: "Amount" }];
const breakdownColumns: ExportColumn[] = [{ key: "label", header: "Label" }, { key: "value", header: "Amount" }];

function salesExportPayload(data: Awaited<ReturnType<typeof getSalesReportData>>): ReportExportPayload {
  return {
    summary: [
      { label: "Total Sales", value: formatMoney(data.totalSales) },
      { label: "Revenue", value: formatMoney(data.revenue) },
      { label: "Number of Bills", value: String(data.billCount) },
      { label: "Average Bill Value", value: formatMoney(data.averageBillValue) },
    ],
    tables: [
      { title: "Sales Trend", columns: trendColumns, rows: data.salesTrend },
      { title: "Payment Breakdown", columns: breakdownColumns, rows: data.paymentBreakdown.map((p) => ({ label: p.label, value: formatMoney(p.value) })) },
    ],
  };
}

function purchasesExportPayload(data: Awaited<ReturnType<typeof getPurchaseReportData>>): ReportExportPayload {
  return {
    summary: [
      { label: "Total Purchases", value: String(data.totalPurchases) },
      { label: "Purchase Cost", value: formatMoney(data.purchaseCost) },
      { label: "Purchase Bills", value: String(data.billCount) },
    ],
    tables: [
      { title: "Purchase Trend", columns: trendColumns, rows: data.purchaseTrend },
      { title: "Top Suppliers", columns: breakdownColumns, rows: data.topSuppliers.map((s) => ({ label: s.label, value: formatMoney(s.value) })) },
    ],
  };
}

function expensesExportPayload(data: Awaited<ReturnType<typeof getExpenseReportData>>): ReportExportPayload {
  return {
    summary: [
      { label: "Total Expenses", value: formatMoney(data.totalExpenses) },
      { label: "Top Category", value: data.topCategory },
    ],
    tables: [
      { title: "Expense Trend", columns: trendColumns, rows: data.expenseTrend },
      { title: "Category Breakdown", columns: breakdownColumns, rows: data.categoryBreakdown.map((c) => ({ label: c.label, value: formatMoney(c.value) })) },
    ],
  };
}

function profitExportPayload(data: Awaited<ReturnType<typeof getProfitReportData>>): ReportExportPayload {
  return {
    summary: [
      { label: "Revenue", value: formatMoney(data.revenue) },
      { label: "Purchase Cost", value: formatMoney(data.purchaseCost) },
      { label: "Expenses", value: formatMoney(data.expenses) },
      { label: "Estimated Profit", value: formatMoney(data.estimatedProfit) },
    ],
  };
}

const REPORT_TITLES: Record<string, string> = {
  sales: "Sales Report",
  purchases: "Purchase Report",
  expenses: "Expense Report",
  profit: "Profit Report",
};

export default async function adminReportsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/reports/sales ──────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/sales", async (request) => {
    const admin = request.authUser!;
    const q = rangeQuerySchema.parse(request.query);
    return getSalesReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo);
  });

  // ── GET /api/admin/reports/purchases ─────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/purchases", async (request) => {
    const admin = request.authUser!;
    const q = rangeQuerySchema.parse(request.query);
    return getPurchaseReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo);
  });

  // ── GET /api/admin/reports/expenses ──────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/expenses", async (request) => {
    const admin = request.authUser!;
    const q = rangeQuerySchema.parse(request.query);
    return getExpenseReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo);
  });

  // ── GET /api/admin/reports/profit ────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/profit", async (request) => {
    const admin = request.authUser!;
    const q = rangeQuerySchema.parse(request.query);
    return getProfitReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo);
  });

  // ── GET /api/admin/reports/payment-breakdown ─────────────────────────
  // (Cashier app has no equivalent; kept for the master-prompt spec.)
  fastify.get<{ Querystring: Record<string, string> }>("/payment-breakdown", async (request) => {
    const admin = request.authUser!;
    const q = rangeQuerySchema.parse(request.query);
    const { from, to } = resolveRange(q.range, q.dateFrom, q.dateTo);

    const bills = await prisma.bill.findMany({
      where: { shopId: admin.shopId!, status: "PAID", createdAt: { gte: from, lte: to } },
      include: { payments: true },
    });
    const methodTotals: Record<string, number> = { Cash: 0, UPI: 0, Card: 0, Credit: 0 };
    for (const b of bills) for (const p of b.payments) methodTotals[PAYMENT_LABEL[p.method]] += toNumber(p.amount);
    return Object.entries(methodTotals).map(([label, value]) => ({ label, value }));
  });

  // ── GET /api/admin/reports/export ────────────────────────────────────
  // type=sales|purchases|expenses|profit, format=excel|csv|pdf. Reuses the
  // exact same data-fetch functions as the JSON endpoints above, so an
  // export always matches what the on-screen report shows for that range.
  fastify.get<{ Querystring: Record<string, string> }>("/export", async (request, reply) => {
    const admin = request.authUser!;
    const q = exportQuerySchema.parse(request.query);

    const [payload, shop] = await Promise.all([
      (async (): Promise<ReportExportPayload> => {
        switch (q.type) {
          case "sales":
            return salesExportPayload(await getSalesReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo));
          case "purchases":
            return purchasesExportPayload(await getPurchaseReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo));
          case "expenses":
            return expensesExportPayload(await getExpenseReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo));
          case "profit":
            return profitExportPayload(await getProfitReportData(admin.shopId!, q.range, q.dateFrom, q.dateTo));
        }
      })(),
      prisma.shop.findUnique({ where: { id: admin.shopId! } }),
    ]);

    const shopName = shop?.name ?? "Shop";
    const title = REPORT_TITLES[q.type];
    const entity = title.replace(/\s+/g, "_");
    const filename = buildExportFilename(shopName, entity, extensionFor(q.format));

    let buffer: Buffer;
    if (q.format === "csv") buffer = buildReportCsvBuffer(payload);
    else if (q.format === "excel") buffer = await buildReportExcelBuffer(payload);
    else buffer = await buildReportPdfBuffer(`${shopName} — ${title}`, `Range: ${q.range}`, payload);

    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .type(contentTypeFor(q.format))
      .send(buffer);
  });
}
