import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { toNumber } from "../../lib/money.js";
import { productStatusLabel, PAYMENT_LABEL } from "../../lib/serializeAdmin.js";

const kpisQuerySchema = z.object({ range: z.enum(["today", "week", "month", "custom"]).default("today") });
const salesQuerySchema = z.object({ window: z.enum(["7d", "30d", "3m"]).default("7d") });
const txnQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) });

const COMPARISON_LABEL: Record<string, string> = {
  today: "vs yesterday",
  week: "vs last week",
  month: "vs last month",
  custom: "custom range",
};

function periodBounds(range: string): { curFrom: Date; curTo: Date; prevFrom: Date; prevTo: Date } {
  const now = new Date();
  const curTo = now;
  const curFrom = new Date(now);
  let days = 1;
  if (range === "week") days = 7;
  else if (range === "month") days = 30;
  if (range === "today") curFrom.setHours(0, 0, 0, 0);
  else curFrom.setDate(curFrom.getDate() - days);

  const prevTo = new Date(curFrom);
  const prevFrom = new Date(curFrom);
  if (range === "today") prevFrom.setDate(prevFrom.getDate() - 1);
  else prevFrom.setDate(prevFrom.getDate() - days);

  return { curFrom, curTo, prevFrom, prevTo };
}

function pctChange(current: number, previous: number): number {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export default async function adminDashboardRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/dashboard/kpis?range= ──────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/kpis", async (request) => {
    const admin = request.authUser!;
    const q = kpisQuerySchema.parse(request.query);
    const { curFrom, curTo, prevFrom, prevTo } = periodBounds(q.range);

    const [curBills, prevBills] = await Promise.all([
      prisma.bill.findMany({ where: { shopId: admin.shopId!, status: "PAID", createdAt: { gte: curFrom, lte: curTo } }, include: { payments: true } }),
      prisma.bill.findMany({ where: { shopId: admin.shopId!, status: "PAID", createdAt: { gte: prevFrom, lte: prevTo } }, include: { payments: true } }),
    ]);

    function totals(bills: typeof curBills) {
      const sales = bills.reduce((s, b) => s + toNumber(b.grandTotal), 0);
      const cash = bills.flatMap((b) => b.payments).filter((p) => p.method === "CASH").reduce((s, p) => s + toNumber(p.amount), 0);
      const credit = bills.flatMap((b) => b.payments).filter((p) => p.method === "CREDIT").reduce((s, p) => s + toNumber(p.amount), 0);
      return { sales, cash, credit };
    }

    const cur = totals(curBills);
    const prev = totals(prevBills);

    return {
      totalSales: cur.sales,
      totalSalesTrend: pctChange(cur.sales, prev.sales),
      totalRevenue: cur.sales,
      totalRevenueTrend: pctChange(cur.sales, prev.sales),
      cashSales: cur.cash,
      cashSalesTrend: pctChange(cur.cash, prev.cash),
      creditSales: cur.credit,
      creditSalesTrend: pctChange(cur.credit, prev.credit),
      comparisonLabel: COMPARISON_LABEL[q.range] ?? "vs previous period",
    };
  });

  // ── GET /api/admin/dashboard/sales?window= ────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/sales", async (request) => {
    const admin = request.authUser!;
    const q = salesQuerySchema.parse(request.query);
    const days = q.window === "7d" ? 7 : q.window === "30d" ? 30 : 84; // 3m ≈ 12 weeks
    const from = new Date();
    from.setDate(from.getDate() - days);

    const bills = await prisma.bill.findMany({
      where: { shopId: admin.shopId!, status: "PAID", createdAt: { gte: from } },
    });

    if (q.window === "3m") {
      const buckets = new Array(12).fill(0);
      const start = new Date(from);
      for (const b of bills) {
        const weekIdx = Math.min(11, Math.floor((b.createdAt.getTime() - start.getTime()) / (7 * 86400000)));
        if (weekIdx >= 0) buckets[weekIdx] += toNumber(b.grandTotal);
      }
      return buckets.map((value, i) => ({ label: `W${i + 1}`, value }));
    }

    const byDay = new Map<string, number>();
    for (const b of bills) {
      const key = b.createdAt.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + toNumber(b.grandTotal));
    }
    const points: { label: string; value: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = q.window === "7d" ? d.toLocaleDateString("en-US", { weekday: "short" }) : String(days - i);
      points.push({ label, value: byDay.get(key) ?? 0 });
    }
    return points;
  });

  // ── GET /api/admin/dashboard/transactions?limit= ──────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/transactions", async (request) => {
    const admin = request.authUser!;
    const q = txnQuerySchema.parse(request.query);

    const bills = await prisma.bill.findMany({
      where: { shopId: admin.shopId!, status: "PAID" },
      include: { payments: true, customer: true },
      orderBy: { createdAt: "desc" },
      take: q.limit,
    });

    return bills.map((b) => {
      const primary = [...b.payments].sort((a, c) => toNumber(c.amount) - toNumber(a.amount))[0];
      return {
        id: b.id,
        billNumber: b.billNumber ?? b.id,
        customerName: b.customer?.name ?? "Walk-in Customer",
        amount: toNumber(b.grandTotal),
        paymentMethod: primary ? PAYMENT_LABEL[primary.method] : "Cash",
        time: b.createdAt.toISOString(),
        status: "Completed" as const,
      };
    });
  });

  // ── GET /api/admin/dashboard/low-stock ─────────────────────────────────
  fastify.get("/low-stock", async (request) => {
    const admin = request.authUser!;
    const items = await prisma.product.findMany({ where: { shopId: admin.shopId!, status: "ACTIVE" } });
    return items
      .filter((p) => productStatusLabel(p) !== "In Stock")
      .map((p) => ({
        productId: p.id,
        productName: p.name,
        currentStock: p.stock,
        unit: p.unit.toLowerCase(),
        threshold: p.lowStockThreshold,
        status: p.stock <= 0 ? ("Critical" as const) : ("Low Stock" as const),
      }));
  });
}
