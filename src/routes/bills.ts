import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { parseBody } from "../lib/validate.js";
import { recordAudit } from "../lib/audit.js";
import { toCashierBill, toHeldBill, METHOD_MAP_REVERSE } from "../lib/serializeCashier.js";
import { checkoutBill } from "../services/billingService.js";
import { add, mul, round2, toDecimal, ZERO } from "../lib/money.js";

const BILL_INCLUDE = {
  items: { include: { product: true } },
  payments: true,
  customer: true,
  cashier: { select: { name: true } },
} satisfies Prisma.BillInclude;

const holdSchema = z.object({
  label: z.string().trim().max(120).optional(),
  customer: z.object({ id: z.string() }).nullable().optional(),
  items: z
    .array(
      z.object({
        product: z.object({ id: z.string() }),
        quantity: z.number().positive(),
        // Bill-only price override from the cart's "Selling Price (this
        // bill)" field — see billingService.ts. Optional; falls back to
        // catalog price when omitted.
        unitPrice: z.number().nonnegative().optional(),
      })
    )
    .min(1, "Cannot hold an empty bill."),
});

const checkoutSchema = z.object({
  customer: z.object({ id: z.string() }).nullable().optional(),
  items: z
    .array(
      z.object({
        product: z.object({ id: z.string() }),
        quantity: z.number().positive(),
        unitPrice: z.number().nonnegative().optional(),
      })
    )
    .min(1),
  payments: z
    .array(
      z.object({
        method: z.string(),
        amount: z.number(),
        reference: z.string().optional(),
        cashReceived: z.number().optional(),
      })
    )
    .min(1),
  idempotencyKey: z.string().optional(),
});

const historyQuerySchema = z.object({
  query: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  paymentMethod: z.string().optional(),
  customerId: z.string().optional(),
});

export default async function billsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("CASHIER"));

  // ── GET /api/bills/held ────────────────────────────────────────────
  // NOTE: registered before "/:id"-style routes to avoid path collisions.
  fastify.get("/held", async (request) => {
    const shopId = request.authUser!.shopId!;
    const bills = await prisma.bill.findMany({
      where: { shopId, status: "HELD" },
      include: BILL_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return bills.map(toHeldBill);
  });

  // ── POST /api/bills/hold ───────────────────────────────────────────
  fastify.post("/hold", async (request) => {
    const cashier = request.authUser!;
    const body = parseBody(holdSchema, request.body);

    const productIds = body.items.map((i) => i.product.id);
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, shopId: cashier.shopId! } });
    const productMap = new Map(products.map((p) => [p.id, p]));

    let amount = ZERO;
    const resolvedHoldItems = body.items.map((item) => {
      const product = productMap.get(item.product.id);
      if (!product) throw Errors.notFound(`Product not found: ${item.product.id}`, "PRODUCT_NOT_FOUND");
      const unitPrice = item.unitPrice != null ? toDecimal(item.unitPrice) : product.sellingPrice;
      return { item, product, unitPrice };
    });
    for (const { item, unitPrice } of resolvedHoldItems) {
      amount = add(amount, mul(unitPrice, item.quantity));
    }

    const held = await prisma.bill.create({
      data: {
        shopId: cashier.shopId!,
        cashierId: cashier.id,
        customerId: body.customer?.id ?? null,
        label: body.label,
        subtotal: round2(amount),
        grandTotal: round2(amount),
        status: "HELD",
        heldAt: new Date(),
        items: {
          create: resolvedHoldItems.map(({ item, product, unitPrice }) => ({
            productId: product.id,
            productName: product.name,
            unit: product.unit,
            quantity: item.quantity,
            unitPrice: round2(unitPrice),
            lineTotal: round2(mul(unitPrice, item.quantity)),
          })),
        },
      },
      include: BILL_INCLUDE,
    });

    await recordAudit({
      action: "BILL_HELD",
      actorId: cashier.id,
      actorRole: "CASHIER",
      shopId: cashier.shopId,
      entityType: "Bill",
      entityId: held.id,
    });

    return toHeldBill(held);
  });

  // ── DELETE /api/bills/held/:id ─────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>("/held/:id", async (request) => {
    const cashier = request.authUser!;
    const bill = await prisma.bill.findUnique({ where: { id: request.params.id } });
    if (!bill || bill.shopId !== cashier.shopId || bill.status !== "HELD") {
      throw Errors.notFound("Held bill not found.", "HELD_BILL_NOT_FOUND");
    }
    await prisma.bill.delete({ where: { id: bill.id } });
    await recordAudit({
      action: "BILL_HELD_DELETED",
      actorId: cashier.id,
      actorRole: "CASHIER",
      shopId: cashier.shopId,
      entityType: "Bill",
      entityId: bill.id,
    });
    return { ok: true };
  });

  // ── POST /api/bills/checkout ───────────────────────────────────────
  fastify.post(
    "/checkout",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const cashier = request.authUser!;
      const body = parseBody(checkoutSchema, request.body);

      return checkoutBill({
        shopId: cashier.shopId!,
        cashierId: cashier.id,
        customerId: body.customer?.id ?? null,
        items: body.items.map((i) => ({ productId: i.product.id, quantity: i.quantity, unitPrice: i.unitPrice })),
        payments: body.payments,
        idempotencyKey: body.idempotencyKey ?? null,
      });
    }
  );

  // ── GET /api/bills/history ─────────────────────────────────────────
  fastify.get<{ Querystring: z.infer<typeof historyQuerySchema> }>("/history", async (request) => {
    const cashier = request.authUser!;
    const q = historyQuerySchema.parse(request.query);

    const bills = await prisma.bill.findMany({
      where: {
        shopId: cashier.shopId!,
        cashierId: cashier.id,
        status: "PAID",
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(q.dateFrom || q.dateTo
          ? { createdAt: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) } }
          : {}),
        ...(q.paymentMethod ? { payments: { some: { method: METHOD_MAP_REVERSE[q.paymentMethod] as never } } } : {}),
        ...(q.query
          ? {
              OR: [
                { billNumber: { contains: q.query, mode: "insensitive" } },
                { customer: { name: { contains: q.query, mode: "insensitive" } } },
                { customer: { phone: { contains: q.query } } },
              ],
            }
          : {}),
      },
      include: BILL_INCLUDE,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return bills.map(toCashierBill);
  });

  // ── GET /api/bills/:id ──────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    const cashier = request.authUser!;
    const bill = await prisma.bill.findUnique({ where: { id: request.params.id }, include: BILL_INCLUDE });
    if (!bill || bill.shopId !== cashier.shopId) {
      throw Errors.notFound("Bill not found.", "BILL_NOT_FOUND");
    }
    return toCashierBill(bill);
  });
}
