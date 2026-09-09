/**
 * Integration tests for Phase 2 billing, split payments, inventory
 * concurrency, and credit. These hit a real Postgres database via Prisma
 * and are NOT run as part of the default sandboxed build. To run locally:
 *
 *   1. Point DATABASE_URL (in .env) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. npx vitest run test/billing.integration.test.ts
 *
 * Covers master-prompt spec §43–48.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { checkoutBill } from "../src/services/billingService.js";
import { collectPayment } from "../src/services/creditService.js";
import { resetDb } from "./dbReset.js";

let shopId: string;
let cashierId: string;
let productId: string;
let customerId: string;

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();

  const shop = await prisma.shop.create({ data: { name: "Test Shop", code: "TEST" } });
  shopId = shop.id;

  const cashier = await prisma.user.create({
    data: { name: "Cashier One", email: "cashier@test.local", passwordHash: "x", role: "CASHIER", status: "ACTIVE", shopId },
  });
  cashierId = cashier.id;

  const product = await prisma.product.create({
    data: { shopId, name: "Egg Tray", category: "Eggs", sellingPrice: 100, stock: 10, unit: "TRAY", lowStockThreshold: 2 },
  });
  productId = product.id;

  const customer = await prisma.customer.create({ data: { shopId, name: "Test Customer", phone: "9990001111" } });
  customerId = customer.id;

  await prisma.cashierSession.create({ data: { cashierId, shopId, openingCash: 1000 } });
});

describe("split payments (§44)", () => {
  it("creates ONE bill and THREE payments that sum exactly to the total, deducting stock once", async () => {
    const bill = await checkoutBill({
      shopId,
      cashierId,
      items: [{ productId, quantity: 10 }], // 10 * ₹100 = ₹1000
      payments: [
        { method: "cash", amount: 400 },
        { method: "upi", amount: 300, reference: "UPI123" },
        { method: "card", amount: 300, reference: "CARD123" },
      ],
    });

    expect((bill as { grandTotal: number }).grandTotal).toBe(1000);
    expect((bill as { payments: unknown[] }).payments).toHaveLength(3);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.stock).toBe(0); // deducted exactly once, not three times

    const bills = await prisma.bill.count({ where: { shopId, status: "PAID" } });
    expect(bills).toBe(1);
  });

  it("rejects a mismatched split payment total", async () => {
    await expect(
      checkoutBill({
        shopId,
        cashierId,
        items: [{ productId, quantity: 1 }], // ₹100
        payments: [
          { method: "cash", amount: 50 },
          { method: "upi", amount: 40 },
        ],
      })
    ).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
  });
});

describe("inventory concurrency (§45)", () => {
  it("lets only one of two concurrent overlapping requests succeed, never going negative", async () => {
    const attempt = (qty: number) =>
      checkoutBill({
        shopId,
        cashierId,
        items: [{ productId, quantity: qty }],
        payments: [{ method: "cash", amount: qty * 100 }],
      }).then(
        () => "ok" as const,
        () => "failed" as const
      );

    const [a, b] = await Promise.all([attempt(7), attempt(7)]); // stock is 10
    const results = [a, b];
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "failed")).toHaveLength(1);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.stock).toBeGreaterThanOrEqual(0);
  });
});

describe("payment idempotency (§46)", () => {
  it("replaying the same idempotency key never creates a second bill", async () => {
    const payload = {
      shopId,
      cashierId,
      items: [{ productId, quantity: 1 }],
      payments: [{ method: "cash", amount: 100 }],
      idempotencyKey: "double-click-key-1",
    };

    const [first, second] = await Promise.all([checkoutBill(payload), checkoutBill(payload)]);
    expect((first as { id: string }).id).toBe((second as { id: string }).id);

    const count = await prisma.bill.count({ where: { shopId } });
    expect(count).toBe(1);

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.stock).toBe(9); // deducted exactly once
  });
});

describe("credit (§47)", () => {
  it("raises the customer balance on a credit sale and lowers it on collection, without creating a fake sale", async () => {
    await checkoutBill({
      shopId,
      cashierId,
      customerId,
      items: [{ productId, quantity: 2 }], // ₹200
      payments: [{ method: "credit", amount: 200 }],
    });

    let customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(Number(customer.creditBalance)).toBe(200);

    await prisma.$transaction((tx) =>
      collectPayment(tx, { shopId, customerId, amount: 75, method: "CASH", actorId: cashierId })
    );

    customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(Number(customer.creditBalance)).toBe(125);

    const salesCount = await prisma.bill.count({ where: { shopId, status: "PAID" } });
    expect(salesCount).toBe(1); // collection did not create a second sale
  });
});
