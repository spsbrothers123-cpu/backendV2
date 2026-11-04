import type { Prisma, PaymentMethod as PrismaPaymentMethod } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library.js";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { toDecimal, add, mul, round2, equalsMoney, toNumber, ZERO } from "../lib/money.js";
import { getEffectivePrices } from "../lib/pricing.js";
import { nextBillNumber } from "../lib/billNumber.js";
import { adjustStock, getCashierStockMap } from "./inventoryService.js";
import { chargeCredit } from "./creditService.js";
import { recordAudit } from "../lib/audit.js";
import { METHOD_MAP_REVERSE, toCashierBill } from "../lib/serializeCashier.js";
import { assignedToShop } from "../lib/branchCatalog.js";

const BILL_INCLUDE = {
  items: { include: { product: true } },
  payments: true,
  customer: true,
  cashier: { select: { name: true } },
} satisfies Prisma.BillInclude;

interface CheckoutItemInput {
  productId: string;
  quantity: number;
  // Stage 2.5: there is intentionally NO price field here. The unit price is
  // resolved by the backend (branch override, else common price) — a
  // client-supplied price is never an input to checkout.
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

/**
 * Stage 2.7 — backend stock gate for the Cashier's branch.
 *
 *  - A product with zero stock can never enter a cart / bill  -> OUT_OF_STOCK
 *  - Quantity above what is available is refused              -> INSUFFICIENT_STOCK
 *    (`zeroOnly` skips this second rule: holding a bill reserves nothing,
 *    so only the zero-stock rule applies there.)
 *
 * This is a fast, friendly pre-check against the branch's own stock. It is
 * NOT the safety net: the authoritative, race-free check is the atomic
 * conditional UPDATE inside adjustStock() in the checkout transaction, so a
 * stale read here can never oversell.
 */
export async function assertStockAvailable(
  db: Parameters<typeof getCashierStockMap>[0],
  input: {
    shopId: string;
    cashierId: string;
    lines: { productId: string; productName: string; quantity: number }[];
    zeroOnly?: boolean;
  }
): Promise<void> {
  const wanted = new Map<string, { name: string; qty: number }>();
  for (const l of input.lines) {
    const cur = wanted.get(l.productId);
    wanted.set(l.productId, { name: l.productName, qty: (cur?.qty ?? 0) + l.quantity });
  }
  const stock = await getCashierStockMap(db, input.shopId, input.cashierId, [...wanted.keys()]);
  for (const [productId, { name, qty }] of wanted) {
    const available = stock.get(productId) ?? 0;
    if (available <= 0) {
      throw Errors.conflict(`"${name}" is out of stock.`, "OUT_OF_STOCK");
    }
    if (!input.zeroOnly && qty > available) {
      throw Errors.conflict(
        `Only ${available} of "${name}" available at this branch; the bill asks for ${qty}.`,
        "INSUFFICIENT_STOCK"
      );
    }
  }
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

  // ── Phase 3: a customer attached to this bill must be this cashier's
  // own — never another cashier's (or another shop's, if the id happened
  // to be guessable). Admin-created/unassigned customers (cashierId null)
  // are still off-limits here too: billing always attaches to a customer
  // this specific cashier created. ─────────────────────────────────────
  if (input.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer || customer.shopId !== input.shopId || customer.cashierId !== input.cashierId) {
      throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
    }
  }

  // ── Resolve products & prices from the DATABASE — never the frontend. ─
  const productIds = [...new Set(input.items.map((i) => i.productId))];
  const products = await prisma.product.findMany({ where: { id: { in: productIds }, ...assignedToShop(input.shopId) } });
  const productMap = new Map(products.map((p) => [p.id, p]));

  for (const item of input.items) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      throw Errors.validation("Each item quantity must be greater than zero.");
    }
    if (!Number.isInteger(item.quantity)) {
      throw Errors.validation("Each item quantity must be a whole number.");
    }
    const product = productMap.get(item.productId);
    if (!product) {
      throw Errors.notFound(`Product not found: ${item.productId}`, "PRODUCT_NOT_FOUND");
    }
    if (product.status !== "ACTIVE") {
      throw Errors.badRequest(`"${product.name}" is not available for sale.`, "PRODUCT_INACTIVE");
    }
  }

  // ── Stage 2.7: reject zero-stock / over-stock lines up front (this branch's
  // stock only). The atomic deduction below remains the real guarantee. ──
  await assertStockAvailable(prisma, {
    shopId: input.shopId,
    cashierId: input.cashierId,
    lines: input.items.map((i) => ({
      productId: i.productId,
      productName: productMap.get(i.productId)!.name,
      quantity: i.quantity,
    })),
  });

  // ── Resolve each line's price on the SERVER: the branch's price override
  // when set, otherwise the common catalog price (Stage 2.5). Kept as an
  // array parallel to input.items so two lines for the same product resolve
  // independently. The resolved prices are re-checked inside the transaction
  // below, so a price change that lands between this read and the commit can
  // never produce a bill at a price the payment totals weren't validated for.
  const effectivePrices = await getEffectivePrices(prisma, input.shopId, products);
  const resolvedItems = input.items.map((item) => {
    const product = productMap.get(item.productId)!;
    const unitPrice = effectivePrices.get(product.id)!;
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
      // Re-resolve prices inside the transaction; abort (nothing written) if
      // an admin changed a price after the totals were validated above.
      const txPrices = await getEffectivePrices(tx, input.shopId, products);
      for (const { product, unitPrice } of resolvedItems) {
        if (!txPrices.get(product.id)?.equals(unitPrice)) {
          throw Errors.conflict(
            `The price of "${product.name}" changed while billing. Please review the cart and try again.`,
            "PRICE_CHANGED"
          );
        }
      }

      // Stock deduction — atomic and concurrency-safe per line item. Lines are
      // taken in a fixed (productId) order so two concurrent checkouts that
      // share products always lock inventory rows in the same order and can
      // never deadlock each other.
      const deductionOrder = [...input.items].sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
      for (const item of deductionOrder) {
        await adjustStock(tx, {
          shopId: input.shopId,
          // Stock is deducted from THIS branch only (shopId from the
          // authenticated cashier). cashierId is the authenticated cashier
          // from the route, never a body value: it owns the row before the
          // BranchInventory cutover and is actor metadata afterwards.
          cashierId: input.cashierId,
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
