import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { paginate, PAYMENT_LABEL } from "../../lib/serializeAdmin.js";
import { toNumber } from "../../lib/money.js";

const queryQuerySchema = z.object({
  search: z.string().optional(),
  type: z.enum(["Sale", "Purchase", "Payment", "all"]).optional(),
  paymentMethod: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

interface HistoryRecord {
  id: string;
  time: string;
  type: "Sale" | "Purchase" | "Payment";
  reference: string;
  party: string;
  amount: number;
  paymentMethod: string;
  createdBy: string;
}

export default async function adminHistoryRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/history ─────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = queryQuerySchema.parse(request.query);
    const shopId = admin.shopId!;

    const dateFilter =
      q.dateFrom || q.dateTo
        ? { gte: q.dateFrom ? new Date(q.dateFrom) : undefined, lte: q.dateTo ? new Date(q.dateTo) : undefined }
        : undefined;

    const wantSales = !q.type || q.type === "all" || q.type === "Sale";
    const wantPurchases = !q.type || q.type === "all" || q.type === "Purchase";
    const wantPayments = !q.type || q.type === "all" || q.type === "Payment";

    const records: HistoryRecord[] = [];

    if (wantSales) {
      const bills = await prisma.bill.findMany({
        where: { shopId, status: "PAID", ...(dateFilter ? { createdAt: dateFilter } : {}) },
        include: { payments: true, customer: true, cashier: true },
        take: 500,
      });
      for (const b of bills) {
        const methods = [...new Set(b.payments.map((p) => PAYMENT_LABEL[p.method]))];
        records.push({
          id: `sale-${b.id}`,
          time: b.createdAt.toISOString(),
          type: "Sale",
          reference: b.billNumber ?? b.id,
          party: b.customer?.name ?? "Walk-in Customer",
          amount: toNumber(b.grandTotal),
          paymentMethod: methods.length > 1 ? "Split" : methods[0] ?? "—",
          createdBy: b.cashier?.name ?? "Cashier",
        });
      }
    }

    if (wantPurchases) {
      const purchases = await prisma.purchase.findMany({
        where: { shopId, ...(dateFilter ? { createdAt: dateFilter } : {}) },
        include: { createdBy: true },
        take: 500,
      });
      for (const p of purchases) {
        records.push({
          id: `purchase-${p.id}`,
          time: p.purchaseDate.toISOString(),
          type: "Purchase",
          reference: p.invoiceNumber,
          party: p.supplierName,
          amount: toNumber(p.grandTotal),
          paymentMethod: "—",
          createdBy: p.createdBy?.name ?? "Admin",
        });
      }
    }

    if (wantPayments) {
      const txns = await prisma.creditTransaction.findMany({
        where: { shopId, type: "COLLECTION", ...(dateFilter ? { createdAt: dateFilter } : {}) },
        include: { customer: true, actor: true },
        take: 500,
      });
      for (const t of txns) {
        records.push({
          id: `payment-${t.id}`,
          time: t.createdAt.toISOString(),
          type: "Payment",
          reference: t.reference ?? t.id,
          party: t.customer.name,
          amount: toNumber(t.amount),
          paymentMethod: t.method ? PAYMENT_LABEL[t.method] : "Cash",
          createdBy: t.actor?.name ?? "Admin",
        });
      }
    }

    let filtered = records;
    if (q.search) {
      const s = q.search.toLowerCase();
      filtered = filtered.filter((r) => r.reference.toLowerCase().includes(s) || r.party.toLowerCase().includes(s));
    }
    if (q.paymentMethod && q.paymentMethod !== "all") {
      filtered = filtered.filter((r) => r.paymentMethod === q.paymentMethod);
    }
    filtered.sort((a, b) => (a.time < b.time ? 1 : -1));

    const start = (q.page - 1) * q.pageSize;
    return paginate(filtered.slice(start, start + q.pageSize), filtered.length, q.page, q.pageSize);
  });

  // ── GET /api/admin/history/sales/:reference ──────────────────────────
  fastify.get<{ Params: { reference: string } }>("/sales/:reference", async (request) => {
    const admin = request.authUser!;
    const bill = await prisma.bill.findFirst({
      where: { shopId: admin.shopId!, OR: [{ billNumber: request.params.reference }, { id: request.params.reference }] },
      include: { items: true, payments: true, customer: true, cashier: true },
    });
    if (!bill) throw Errors.notFound("Sale not found.", "SALE_NOT_FOUND");

    const methods = [...new Set(bill.payments.map((p) => PAYMENT_LABEL[p.method]))];
    return {
      billNumber: bill.billNumber ?? bill.id,
      date: bill.createdAt.toISOString(),
      customerName: bill.customer?.name ?? "Walk-in Customer",
      items: bill.items.map((it) => ({ name: it.productName, quantity: it.quantity, price: toNumber(it.unitPrice) })),
      paymentMethod: methods.length > 1 ? "Split" : methods[0] ?? "—",
      total: toNumber(bill.grandTotal),
      createdBy: bill.cashier?.name ?? "Cashier",
    };
  });

  // ── GET /api/admin/history/purchases/:reference ──────────────────────
  fastify.get<{ Params: { reference: string } }>("/purchases/:reference", async (request) => {
    const admin = request.authUser!;
    const purchase = await prisma.purchase.findFirst({
      where: { shopId: admin.shopId!, OR: [{ invoiceNumber: request.params.reference }, { id: request.params.reference }] },
      include: { items: true },
    });
    if (!purchase) throw Errors.notFound("Purchase not found.", "PURCHASE_NOT_FOUND");

    return {
      invoiceNumber: purchase.invoiceNumber,
      supplierName: purchase.supplierName,
      date: purchase.purchaseDate.toISOString(),
      items: purchase.items.map((it) => ({ name: it.productName, quantity: it.quantity, purchasePrice: toNumber(it.purchasePrice) })),
      total: toNumber(purchase.grandTotal),
    };
  });

  // ── GET /api/admin/history/payments/:reference ────────────────────────
  fastify.get<{ Params: { reference: string } }>("/payments/:reference", async (request) => {
    const admin = request.authUser!;
    const txn = await prisma.creditTransaction.findFirst({
      where: {
        shopId: admin.shopId!,
        type: "COLLECTION",
        OR: [{ reference: request.params.reference }, { id: request.params.reference }],
      },
      include: { customer: true, actor: true },
    });
    if (!txn) throw Errors.notFound("Payment not found.", "PAYMENT_NOT_FOUND");

    return {
      customerName: txn.customer.name,
      amount: toNumber(txn.amount),
      method: txn.method ? PAYMENT_LABEL[txn.method] : "Cash",
      reference: txn.reference ?? undefined,
      date: txn.createdAt.toISOString(),
      createdBy: txn.actor?.name ?? "Admin",
    };
  });
}
