import type { Prisma, PaymentMethod as PrismaPaymentMethod } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library.js";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { toDecimal, add, mul, round2, equalsMoney, toNumber, ZERO } from "../lib/money.js";
import { nextBillNumber } from "../lib/billNumber.js";
import { adjustStock } from "./inventoryService.js";
import { chargeCredit } from "./creditService.js";
import { recordAudit } from "../lib/audit.js";
import { METHOD_MAP_REVERSE, toCashierBill } from "../lib/serializeCashier.js";

const BILL_INCLUDE = {
  items: { include: { product: true } },
  payments: true,
  customer: true,
  cashier: { select: { name: true } },
} satisfies Prisma.BillInclude;

interface CheckoutItemInput {
  productId: string;
  quantity: number;
  /**
   * Optional bill-only price override for this line, set by the cashier
   * via the "Selling Price (this bill)" field in the cart editor. When
   * omitted, the product's catalog `sellingPrice` is used. The catalog
   * price itself is never touched — this only affects this one bill's
   * line total. Still resolved/clamped here (never trusted blindly): must
   * be a finite, non-negative number.
   */
  unitPrice?: number;
}

interface CheckoutPaymentInput {
  method: string;
  amount: number;
  reference?: string;
  cashReceived?: number;
}

interface CheckoutInput {
  shopId: string;
  cashierId: string;
  customerId?: string | null;
  items: CheckoutItemInput[];
  payments: CheckoutPaymentInput[];
  idempotencyKey?: string | null;
}

async function findActiveSession(shopId: string, cashierId: string) {
  const session = await prisma.cashierSession.findFirst({
    where: { shopId, cashierId, status: "OPEN" },
  });
  if (!session) {
    throw Errors.conflict(
      "Start a cashier session before billing.",
      "NO_ACTIVE_SESSION"
    );
  }
  return session;
}

export async function checkoutBill(input: CheckoutInput) {
  // ── Idempotency fast-path — replaying the same key returns the
  // original bill instead of creating a duplicate. ────────────────────
  if (input.idempotencyKey) {
    const existing = await prisma.bill.findUnique({
      where: { shopId_idempotencyKey: { shopId: input.shopId, idempotencyKey: input.idempotencyKey } },
      include: BILL_INCLUDE,
    });
    if (existing) return toCashierBill(existing);
  }

  if (!input.items || input.items.length === 0) {
    throw Errors.badRequest("Cannot check out an empty bill.", "EMPTY_BILL");
  }
  if (!input.payments || input.payments.length === 0) {
    throw Errors.badRequest("At least one payment is required.", "NO_PAYMENTS");
  }

  const session = await findActiveSession(input.shopId, input.cashierId);

  // ── Resolve products & prices from the DATABASE — never the frontend. ─
  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, shopId: input.shopId } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const item of input.items) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw Errors.validation("Each item quantity must be greater than zero.");
    }
    const product = productMap.get(item.productId);
    if (!product) {
      throw Errors.notFound(`Product not found: ${item.productId}`, "PRODUCT_NOT_FOUND");
    }
    if (product.status !== "ACTIVE") {
      throw Errors.badRequest(`"${product.name}" is not available for sale.`, "PRODUCT_INACTIVE");
    }
    if (item.unitPrice != null && (!Number.isFinite(item.unitPrice) || item.unitPrice < 0)) {
      throw Errors.validation(`Overridden price for "${product.name}" must be a non-negative number.`);
    }
  }

  // ── Resolve each line's price: the cashier's bill-only override when
  // present, otherwise the catalog price. The override is never written
  // back to product.sellingPrice — it only affects this bill's line total,
  // and it flows through to the payment-total check below so a bill with
  // overridden prices doesn't get flagged as a mismatch against the stale
  // catalog total. Kept as an array parallel to input.items (not a
  // productId-keyed map) so two lines for the same product with different
  // overrides resolve independently. ──────────────────────────────────
  const priceOverrides: { productId: string; productName: string; catalogPrice: number; overriddenPrice: number }[] = [];
  const resolvedItems = input.items.map((item) => {
    const product = productMap.get(item.productId)!;
    const unitPrice = item.unitPrice != null ? toDecimal(item.unitPrice) : product.sellingPrice;
    if (item.unitPrice != null && !round2(unitPrice).equals(round2(product.sellingPrice))) {
      priceOverrides.push({
        productId: product.id,
        productName: product.name,
        catalogPrice: toNumber(product.sellingPrice),
        overriddenPrice: toNumber(round2(unitPrice)),
      });
    }
    return { item, product, unitPrice };
  });

  let subtotal = ZERO;
  for (const { unitPrice, item } of resolvedItems) {
    subtotal = add(subtotal, mul(unitPrice, item.quantity));
  }
  subtotal = round2(subtotal);
  const discount = ZERO; // No discount rules defined yet — never invented.
  const tax = ZERO; // No tax rules configured yet — never invented.
  const grandTotal = round2(subtotal.minus(discount).plus(tax));

  // ── Validate payments against the BACKEND-computed total. ────────────
    const validMethods = new Set(["cash", "card", "upi", "credit"]);
  let paymentSum = ZERO;
  for (const p of input.payments) {
    p.method = p.method.toLowerCase();
    if (!validMethods.has(p.method)) {
      throw Errors.validation(`Unsupported payment method: ${p.method}`);
    }
    if (!(p.amount > 0)) {
      throw Errors.validation("Each payment amount must be greater than zero.");
    }
    paymentSum = add(paymentSum, toDecimal(p.amount));
  }
  if (!equalsMoney(paymentSum, grandTotal)) {
    throw Errors.badRequest(
      `Payment total (₹${toNumber(round2(paymentSum))}) does not match bill total (₹${toNumber(grandTotal)}).`,
      "PAYMENT_AMOUNT_MISMATCH"
    );
  }
  const creditPayments = input.payments.filter((p) => p.method === "credit");
  if (creditPayments.length > 0 && !input.customerId) {
    throw Errors.badRequest("Select a customer before billing on credit.", "CUSTOMER_REQUIRED_FOR_CREDIT");
  }

  const isSplit = input.payments.length > 1;

  try {
    const bill = await prisma.$transaction(async (tx) => {
      // Stock deduction — atomic and concurrency-safe per line item.
      for (const item of input.items) {
        await adjustStock(tx, {
          shopId: input.shopId,
          productId: item.productId,
          delta: -item.quantity,
          type: "OUT",
          reason: "SALE",
          actorId: input.cashierId,
        });
      }

      const billNumber = await nextBillNumber(tx, input.shopId);

      const created = await tx.bill.create({
        data: {
          shopId: input.shopId,
          cashierId: input.cashierId,
          sessionId: session.id,
          customerId: input.customerId ?? null,
          billNumber,
          subtotal,
          discount,
          tax,
          grandTotal,
          status: "PAID",
          idempotencyKey: input.idempotencyKey ?? null,
          paidAt: new Date(),
          items: {
            create: resolvedItems.map(({ item, product, unitPrice }) => ({
              productId: product.id,
              productName: product.name,
              unit: product.unit,
              quantity: item.quantity,
              unitPrice: round2(unitPrice),
              lineTotal: round2(mul(unitPrice, item.quantity)),
            })),
          },
          payments: {
            create: input.payments.map((p) => {
              const amount = round2(toDecimal(p.amount));
              const cashReceived = p.method === "cash" && p.cashReceived != null ? toDecimal(p.cashReceived) : null;
              const change = cashReceived ? round2(cashReceived.minus(amount)) : null;
              return {
                method: METHOD_MAP_REVERSE[p.method] as PrismaPaymentMethod,
                amount,
                reference: p.reference,
                cashReceived: cashReceived ?? undefined,
                change: change && change.greaterThan(0) ? change : null,
              };
            }),
          },
        },
        include: BILL_INCLUDE,
      });

      for (const p of creditPayments) {
        await chargeCredit(tx, {
          shopId: input.shopId,
          customerId: input.customerId!,
          billId: created.id,
          amount: p.amount,
          actorId: input.cashierId,
        });
      }

      return created;
    },{ timeout: 15_000, maxWait: 10_000 });

    await recordAudit({
      action: "BILL_CREATED",
      actorId: input.cashierId,
      actorRole: "CASHIER",
      shopId: input.shopId,
      entityType: "Bill",
      entityId: bill.id,
      metadata: {
        billNumber: bill.billNumber,
        grandTotal: toNumber(bill.grandTotal),
        ...(priceOverrides.length > 0 ? { priceOverrides } : {}),
      },
    });
    await recordAudit({
      action: isSplit ? "SPLIT_PAYMENT_CREATED" : "PAYMENT_CREATED",
      actorId: input.cashierId,
      actorRole: "CASHIER",
      shopId: input.shopId,
      entityType: "Bill",
      entityId: bill.id,
      metadata: { methods: input.payments.map((p) => p.method) },
    });
    for (const p of creditPayments) {
      await recordAudit({
        action: "CREDIT_PAYMENT_CREATED",
        actorId: input.cashierId,
        actorRole: "CASHIER",
        shopId: input.shopId,
        entityType: "Bill",
        entityId: bill.id,
        metadata: { amount: p.amount },
      });
    }

    const fresh = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id }, include: BILL_INCLUDE });
    return toCashierBill(fresh);
  } catch (err) {
    // Race on idempotency key: another request with the same key won the
    // insert first. Return that bill instead of surfacing a 500/409.
    if (err instanceof PrismaClientKnownRequestError && err.code === "P2002" && input.idempotencyKey) {
      const existing = await prisma.bill.findUnique({
        where: { shopId_idempotencyKey: { shopId: input.shopId, idempotencyKey: input.idempotencyKey } },
        include: BILL_INCLUDE,
      });
      if (existing) return toCashierBill(existing);
    }
    throw err;
  }
}
