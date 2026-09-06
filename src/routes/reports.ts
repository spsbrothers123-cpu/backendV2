import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { toNumber } from "../lib/money.js";

const querySchema = z.object({
  cashierId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export default async function reportsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("CASHIER"));

  // ── GET /api/reports/sales ────────────────────────────────────────────
  fastify.get<{ Querystring: z.infer<typeof querySchema> }>("/sales", async (request) => {
    const cashier = request.authUser!;
    const q = querySchema.parse(request.query);

    const bills = await prisma.bill.findMany({
      where: {
        shopId: cashier.shopId!,
        status: "PAID",
        cashierId: q.cashierId ?? cashier.id,
        ...(q.from || q.to
          ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
          : {}),
      },
      include: { payments: true, items: true },
    });

    const summary = { sales: 0, billCount: bills.length, cashSales: 0, cardSales: 0, upiSales: 0, creditSales: 0 };
    const productTotals = new Map<string, { name: string; quantity: number; revenue: number }>();
    const trendMap = new Map<string, number>();

    for (const bill of bills) {
      summary.sales += toNumber(bill.grandTotal);
      for (const p of bill.payments) {
        if (p.method === "CASH") summary.cashSales += toNumber(p.amount);
        else if (p.method === "CARD") summary.cardSales += toNumber(p.amount);
        else if (p.method === "UPI") summary.upiSales += toNumber(p.amount);
        else if (p.method === "CREDIT") summary.creditSales += toNumber(p.amount);
      }
      for (const item of bill.items) {
        const entry = productTotals.get(item.productId) ?? { name: item.productName, quantity: 0, revenue: 0 };
        entry.quantity += item.quantity;
        entry.revenue += toNumber(item.lineTotal);
        productTotals.set(item.productId, entry);
      }
      const day = bill.createdAt.toISOString().slice(0, 10);
      trendMap.set(day, (trendMap.get(day) ?? 0) + toNumber(bill.grandTotal));
    }

    const topProducts = [...productTotals.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    const trend = [...trendMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([label, value]) => ({ label, value }));
    const averageBillValue = bills.length ? summary.sales / bills.length : 0;

    return { ...summary, averageBillValue, topProducts, trend };
  });
}
