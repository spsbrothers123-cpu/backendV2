import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { paginate, PAYMENT_LABEL } from "../../lib/serializeAdmin.js";
import { toNumber } from "../../lib/money.js";
import { collectPayment } from "../../services/creditService.js";
import type { PaymentMethod } from "@prisma/client";

const listQuerySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const collectSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.enum(["Cash", "UPI", "Card", "Credit"]).default("Cash"),
  reference: z.string().trim().optional(),
  notes: z.string().trim().optional(),
});

const METHOD_TO_PRISMA: Record<z.infer<typeof collectSchema>["method"], PaymentMethod> = {
  Cash: "CASH",
  UPI: "UPI",
  Card: "CARD",
  Credit: "CREDIT",
};

function toCustomerCredit(c: { id: string; name: string; creditBalance: unknown }, paid: number, lastPayment: string | null) {
  const pending = toNumber(c.creditBalance as never);
  return {
    customerId: c.id,
    customerName: c.name,
    totalCredit: pending + paid,
    paid,
    pending,
    lastPayment,
  };
}

export default async function adminCreditsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/credits/summary ────────────────────────────────────
  fastify.get("/summary", async (request) => {
    const admin = request.authUser!;
    const [pendingAgg, collectedAgg] = await Promise.all([
      prisma.customer.aggregate({ where: { shopId: admin.shopId!, creditBalance: { gt: 0 } }, _sum: { creditBalance: true } }),
      prisma.creditTransaction.aggregate({ where: { shopId: admin.shopId!, type: "COLLECTION" }, _sum: { amount: true } }),
    ]);
    const pending = toNumber(pendingAgg._sum.creditBalance);
    const collected = toNumber(collectedAgg._sum.amount);
    return { totalCredit: pending + collected, collected, pending };
  });

  // ── GET /api/admin/credits ─────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = listQuerySchema.parse(request.query);

    const where = {
      shopId: admin.shopId!,
      creditBalance: { gt: 0 },
      ...(q.search ? { name: { contains: q.search, mode: "insensitive" as const } } : {}),
    };

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({ where, orderBy: { name: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.customer.count({ where }),
    ]);

    const items = await Promise.all(
      customers.map(async (c) => {
        const [paidAgg, lastPayment] = await Promise.all([
          prisma.creditTransaction.aggregate({ where: { customerId: c.id, type: "COLLECTION" }, _sum: { amount: true } }),
          prisma.creditTransaction.findFirst({
            where: { customerId: c.id, type: "COLLECTION" },
            orderBy: { createdAt: "desc" },
          }),
        ]);
        return toCustomerCredit(c, toNumber(paidAgg._sum.amount), lastPayment ? lastPayment.createdAt.toISOString().slice(0, 10) : null);
      })
    );

    return paginate(items, total, q.page, q.pageSize);
  });

  // ── GET /api/admin/credits/:customerId/bills ──────────────────────────
  fastify.get<{ Params: { customerId: string } }>("/:customerId/bills", async (request) => {
    const admin = request.authUser!;
    const customer = await prisma.customer.findUnique({ where: { id: request.params.customerId } });
    if (!customer || customer.shopId !== admin.shopId) {
      throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
    }
    const bills = await prisma.bill.findMany({
      where: { customerId: customer.id, status: "PAID", payments: { some: { method: "CREDIT" } } },
      include: { payments: true },
      orderBy: { createdAt: "desc" },
    });
    // NOTE: collections are tracked against the customer's overall balance,
    // not allocated to individual bills, so per-bill paidAmount/status here
    // is an approximation based on whether the customer still owes anything.
    const hasOutstanding = toNumber(customer.creditBalance) > 0;
    return bills.map((b) => {
      const creditPortion = b.payments.filter((p) => p.method === "CREDIT").reduce((s, p) => s + toNumber(p.amount), 0);
      return {
        id: b.id,
        billNumber: b.billNumber ?? b.id,
        date: b.createdAt.toISOString().slice(0, 10),
        amount: creditPortion,
        paidAmount: hasOutstanding ? 0 : creditPortion,
        status: hasOutstanding ? "Pending" : "Paid",
      };
    });
  });

  // ── GET /api/admin/credits/:customerId/timeline ───────────────────────
  fastify.get<{ Params: { customerId: string } }>("/:customerId/timeline", async (request) => {
    const admin = request.authUser!;
    const customer = await prisma.customer.findUnique({ where: { id: request.params.customerId } });
    if (!customer || customer.shopId !== admin.shopId) {
      throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
    }
    const txns = await prisma.creditTransaction.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: "asc" },
      include: { bill: true },
    });
    return txns.map((t) => ({
      id: t.id,
      type: t.type === "CHARGE" ? "bill_created" : "payment",
      date: t.createdAt.toISOString(),
      description:
        t.type === "CHARGE"
          ? `Credit bill ${t.bill?.billNumber ?? ""}`.trim()
          : `Payment collected${t.method ? ` via ${PAYMENT_LABEL[t.method]}` : ""}`,
      amount: toNumber(t.amount),
    }));
  });

  // ── POST /api/admin/credits/:customerId/collect-payment ───────────────
  fastify.post<{ Params: { customerId: string } }>("/:customerId/collect-payment", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(collectSchema, request.body);

    const customer = await prisma.customer.findUnique({ where: { id: request.params.customerId } });
    if (!customer || customer.shopId !== admin.shopId) {
      throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
    }

    const { customer: updated } = await prisma.$transaction((tx) =>
      collectPayment(tx, {
        shopId: admin.shopId!,
        customerId: customer.id,
        amount: body.amount,
        method: METHOD_TO_PRISMA[body.method],
        reference: body.reference,
        notes: body.notes,
        actorId: admin.id,
      })
    );

    await recordAudit({
      action: "CREDIT_PAYMENT_CREATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Customer",
      entityId: customer.id,
      metadata: { amount: body.amount, method: body.method },
    });

    const paidAgg = await prisma.creditTransaction.aggregate({
      where: { customerId: customer.id, type: "COLLECTION" },
      _sum: { amount: true },
    });
    return toCustomerCredit(updated, toNumber(paidAgg._sum.amount), new Date().toISOString().slice(0, 10));
  });
}