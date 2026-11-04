/**
 * RBR Egg Mart V2 — Phase 2, Stage 2.9: regression & security validation.
 *
 * Covers the 22 approved scenarios. Runs ONLY against a disposable local
 * Postgres whose name contains "test" (enforced by test/setup.ts):
 *
 *   1. cp env.test .env.test  and point DATABASE_URL at a LOCAL *_test database
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/phase2.stage29.integration.test.ts
 *
 * Every test starts from resetDb() with inventory_source = BRANCH (the
 * post-cutover architecture). Scenario numbers in the describe titles match
 * the Stage 2.9 list in the Phase 2 prompt.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { checkoutBill } from "../src/services/billingService.js";
import { cancelBill } from "../src/services/billCancellationService.js";
import { adjustStock } from "../src/services/inventoryService.js";
import { assertBranchCashierSlotFree } from "../src/lib/branchCashier.js";
import { assignAllProductsToBranch, assignProductToAllBranches } from "../src/lib/branchCatalog.js";
import { resetDb } from "./dbReset.js";
import { createAdminFixture } from "./adminFixture.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
const envMut = env as unknown as { CENTRAL_ADMIN_USER_ID?: string };

let app: FastifyInstance;

beforeAll(async () => {
  if (!enabled) return;
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  if (!enabled) return;
  await app.close();
  await prisma.$disconnect();
});

// ── helpers ──────────────────────────────────────────────────────────────
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const call = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });
const json = (r: { payload: string }) => JSON.parse(r.payload);

async function setMode(value: "CASHIER" | "BRANCH") {
  await prisma.systemFlag.upsert({
    where: { key: "inventory_source" },
    update: { value },
    create: { key: "inventory_source", value },
  });
}

async function mkShop(code: string) {
  const shop = await prisma.shop.create({ data: { name: `Shop ${code}`, code, location: code } });
  await assignAllProductsToBranch(prisma, shop.id, null);
  return shop;
}

async function mkCashier(shopId: string, email: string, status: "ACTIVE" | "PENDING_ADMIN_APPROVAL" | "SUSPENDED" = "ACTIVE") {
  return prisma.user.create({
    data: { name: email, email, passwordHash: await hashPassword("Password123"), role: "CASHIER", status, shopId },
  });
}

async function mkProduct(originShopId: string, name: string, price = 100) {
  const p = await prisma.product.create({
    data: { shopId: originShopId, name, category: "Eggs", sellingPrice: price, stock: 0, unit: "TRAY", lowStockThreshold: 1 },
  });
  await assignProductToAllBranches(prisma, p.id, null);
  return p;
}

/** Seeds branch stock the legitimate way (through adjustStock) so Product.stock stays the aggregate. */
async function seedStock(shopId: string, productId: string, qty: number, actorId: string | null = null) {
  if (qty === 0) return;
  await prisma.$transaction((tx) =>
    adjustStock(tx, { shopId, productId, delta: qty, type: "IN", reason: "test seed", actorId, cashierId: null })
  );
}

const openSession = (cashierId: string, shopId: string) => prisma.cashierSession.create({ data: { cashierId, shopId, openingCash: 0 } });
const branchQty = async (shopId: string, productId: string) =>
  (await prisma.branchInventory.findUnique({ where: { shopId_productId: { shopId, productId } } }))?.quantity ?? 0;
const productStock = async (productId: string) => (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock;
/** Pays exactly `qty * unit` in cash. */
const sellCash = (shopId: string, cashierId: string, productId: string, quantity: number, unit: number, extra: Record<string, unknown> = {}) =>
  checkoutBill({ shopId, cashierId, items: [{ productId, quantity }], payments: [{ method: "cash", amount: quantity * unit }], ...extra } as never) as Promise<{ id: string }>;

async function aggregateIsConsistent(productId: string) {
  const sum = await prisma.branchInventory.aggregate({ where: { productId }, _sum: { quantity: true } });
  return (await productStock(productId)) === (sum._sum.quantity ?? 0);
}

interface World {
  central: Awaited<ReturnType<typeof createAdminFixture>>;
  other: Awaited<ReturnType<typeof createAdminFixture>>;
  shopA: { id: string };
  shopB: { id: string };
  cashierA: { id: string };
  cashierB: { id: string };
  product: { id: string };
}
let w: World;

beforeEach(async () => {
  if (!enabled) return;
  await resetDb();
  await setMode("BRANCH");

  const central = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
  envMut.CENTRAL_ADMIN_USER_ID = central.user.id;
  const other = await createAdminFixture(app, { email: "other@rbr.test", shopLocation: "Palladam" });
  const shopB = await mkShop("BRANCHB");
  const cashierA = await mkCashier(central.shop.id, "cashier-a@rbr.test");
  const cashierB = await mkCashier(shopB.id, "cashier-b@rbr.test");
  await openSession(cashierA.id, central.shop.id);
  await openSession(cashierB.id, shopB.id);
  const product = await mkProduct(central.shop.id, "Egg Tray", 100);
  w = { central, other, shopA: { id: central.shop.id }, shopB, cashierA, cashierB, product };
});

describe.skipIf(!enabled)("Stage 2.9 — catalog & assignment", () => {
  it("#1 a new product is auto-assigned to every existing branch, with no stock created", async () => {
    const res = await call("POST", "/api/admin/products", w.central.token, {
      name: "Brand New Product", category: "Eggs", sellingPrice: 55, stock: 0, unit: "piece", lowStockThreshold: 0,
    });
    expect(res.statusCode).toBeLessThan(300);
    const p = await prisma.product.findFirstOrThrow({ where: { name: "Brand New Product" } });
    const shops = await prisma.shop.count();
    const links = await prisma.branchProduct.findMany({ where: { productId: p.id } });
    expect(links).toHaveLength(shops);
    expect(links.every((l) => l.isAssigned)).toBe(true);
    expect(await prisma.branchInventory.count({ where: { productId: p.id } })).toBe(0);
  });

  it("#2 a new branch receives every global product at zero stock; existing stock is untouched", async () => {
    await seedStock(w.shopA.id, w.product.id, 7);
    const res = await call("POST", "/api/admin/shops", w.central.token, { location: "Sulur" });
    expect(res.statusCode).toBe(201);
    const newShopId = json(res).data.id as string;
    const links = await prisma.branchProduct.findMany({ where: { shopId: newShopId } });
    expect(links.map((l) => l.productId)).toContain(w.product.id);
    expect(links.every((l) => l.isAssigned)).toBe(true);
    expect(await prisma.branchInventory.count({ where: { shopId: newShopId } })).toBe(0);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(7);
    expect(await productStock(w.product.id)).toBe(7);
  });

  it("#3 unassigning hides the product but preserves stock/history; reassigning restores it; inactive != unassigned", async () => {
    await seedStock(w.shopA.id, w.product.id, 9);
    const off = await call("PUT", `/api/admin/branch-products/${w.product.id}/${w.shopA.id}`, w.central.token, { assigned: false });
    expect(off.statusCode).toBeLessThan(300);

    await expect(sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100)).rejects.toMatchObject({ code: "PRODUCT_NOT_FOUND" });
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(9); // preserved, not deleted
    expect(await prisma.inventoryMovement.count({ where: { productId: w.product.id } })).toBeGreaterThan(0);

    const on = await call("PUT", `/api/admin/branch-products/${w.product.id}/${w.shopA.id}`, w.central.token, { assigned: true });
    expect(on.statusCode).toBeLessThan(300);
    await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(8); // 9 restored, then 1 sold

    // inactive (catalog-wide flag) is a different state from unassigned (BranchProduct.isAssigned)
    await prisma.product.update({ where: { id: w.product.id }, data: { status: "INACTIVE" } });
    const bp = await prisma.branchProduct.findUniqueOrThrow({ where: { shopId_productId: { shopId: w.shopA.id, productId: w.product.id } } });
    expect(bp.isAssigned).toBe(true);
    await expect(sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100)).rejects.toMatchObject({ code: "PRODUCT_INACTIVE" });
  });

  it("#4 branch stock is independent and Product.stock is the aggregate", async () => {
    await seedStock(w.shopA.id, w.product.id, 10);
    await seedStock(w.shopB.id, w.product.id, 4);
    await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 3, 100);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(7);
    expect(await branchQty(w.shopB.id, w.product.id)).toBe(4); // untouched
    expect(await productStock(w.product.id)).toBe(11);
    expect(await aggregateIsConsistent(w.product.id)).toBe(true);
  });
});

describe.skipIf(!enabled)("Stage 2.9 — one Cashier per branch", () => {
  it("#6 a second ACTIVE or PENDING cashier at a branch is refused (app level)", async () => {
    await expect(assertBranchCashierSlotFree(prisma, w.shopA.id)).rejects.toMatchObject({ code: "BRANCH_HAS_CASHIER" });
    await expect(assertBranchCashierSlotFree(prisma, w.shopA.id, w.cashierA.id)).resolves.toBeUndefined(); // excluding self is fine

    await prisma.user.update({ where: { id: w.cashierB.id }, data: { status: "PENDING_ADMIN_APPROVAL" } });
    await expect(assertBranchCashierSlotFree(prisma, w.shopB.id)).rejects.toMatchObject({ code: "BRANCH_HAS_CASHIER" });
  });

  it("#5 replacing a cashier never resets stock and preserves the old cashier's bills/sessions", async () => {
    await seedStock(w.shopA.id, w.product.id, 10);
    const bill = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 2, 100);
    const stockBefore = await branchQty(w.shopA.id, w.product.id);

    await prisma.user.update({ where: { id: w.cashierA.id }, data: { status: "SUSPENDED" } });
    await expect(assertBranchCashierSlotFree(prisma, w.shopA.id)).resolves.toBeUndefined();
    const replacement = await mkCashier(w.shopA.id, "replacement@rbr.test");
    await openSession(replacement.id, w.shopA.id);

    expect(await branchQty(w.shopA.id, w.product.id)).toBe(stockBefore); // no reset
    expect(await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).toMatchObject({ cashierId: w.cashierA.id, status: "PAID" });
    expect(await prisma.cashierSession.count({ where: { cashierId: w.cashierA.id } })).toBe(1);
    // replacement sells from the SAME branch stock
    await sellCash(w.shopA.id, replacement.id, w.product.id, 1, 100);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(stockBefore - 1);
  });
});

describe.skipIf(!enabled)("Stage 2.9 — pricing", () => {
  it("#7/#8 effective price = branch override else common; common-price edits preserve overrides; clearing inherits", async () => {
    await seedStock(w.shopA.id, w.product.id, 20);
    await seedStock(w.shopB.id, w.product.id, 20);

    const set = await call("PUT", `/api/admin/branch-products/${w.product.id}/${w.shopB.id}/price`, w.central.token, { priceOverride: 80 });
    expect(set.statusCode).toBeLessThan(300);

    const a = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100); // common
    const b = await sellCash(w.shopB.id, w.cashierB.id, w.product.id, 1, 80); //  override
    expect(Number((await prisma.billItem.findFirstOrThrow({ where: { billId: a.id } })).unitPrice)).toBe(100);
    expect(Number((await prisma.billItem.findFirstOrThrow({ where: { billId: b.id } })).unitPrice)).toBe(80);

    // common price changes -> override survives, non-override branch follows
    await prisma.product.update({ where: { id: w.product.id }, data: { sellingPrice: 120 } });
    expect(Number((await prisma.branchProduct.findUniqueOrThrow({ where: { shopId_productId: { shopId: w.shopB.id, productId: w.product.id } } })).priceOverride)).toBe(80);
    const a2 = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 120);
    expect(Number((await prisma.billItem.findFirstOrThrow({ where: { billId: a2.id } })).unitPrice)).toBe(120);

    // null clears -> inherits the common price
    await call("PUT", `/api/admin/branch-products/${w.product.id}/${w.shopB.id}/price`, w.central.token, { priceOverride: null });
    const b2 = await sellCash(w.shopB.id, w.cashierB.id, w.product.id, 1, 120);
    expect(Number((await prisma.billItem.findFirstOrThrow({ where: { billId: b2.id } })).unitPrice)).toBe(120);
  });

  it("#9 completed bills keep their original unit prices after any price change", async () => {
    await seedStock(w.shopA.id, w.product.id, 5);
    const bill = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 2, 100);
    await prisma.product.update({ where: { id: w.product.id }, data: { sellingPrice: 999 } });
    await call("PUT", `/api/admin/branch-products/${w.product.id}/${w.shopA.id}/price`, w.central.token, { priceOverride: 555 });
    const items = await prisma.billItem.findMany({ where: { billId: bill.id } });
    expect(items.map((i) => Number(i.unitPrice))).toEqual([100]);
    expect(Number((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).grandTotal)).toBe(200);
  });

  it("security: a client-supplied unitPrice is ignored — the backend price wins", async () => {
    await seedStock(w.shopA.id, w.product.id, 5);
    const bill = (await checkoutBill({
      shopId: w.shopA.id,
      cashierId: w.cashierA.id,
      items: [{ productId: w.product.id, quantity: 1, unitPrice: 1 } as never],
      payments: [{ method: "cash", amount: 100 }],
    })) as { id: string };
    expect(Number((await prisma.billItem.findFirstOrThrow({ where: { billId: bill.id } })).unitPrice)).toBe(100);
    // paying the attacker's price is rejected as a mismatch
    await expect(
      checkoutBill({
        shopId: w.shopA.id,
        cashierId: w.cashierA.id,
        items: [{ productId: w.product.id, quantity: 1, unitPrice: 1 } as never],
        payments: [{ method: "cash", amount: 1 }],
      })
    ).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
  });
});

describe.skipIf(!enabled)("Stage 2.9 — purchases", () => {
  const purchaseBody = (receivingShopId: string | undefined, productId: string, qty: number, invoice = "INV-1") => ({
    supplierName: "Farm Co", invoiceNumber: invoice, purchaseDate: new Date().toISOString(), receivingShopId,
    items: [{ productId, productName: "Egg Tray", quantity: qty, unit: "tray", purchasePrice: 50 }],
  });

  it("#10 stock lands only in the explicitly chosen receiving branch, independent of the shop selector", async () => {
    // Central admin's selected shop is A, receiving branch is B.
    const res = await call("POST", "/api/admin/purchases", w.central.token, purchaseBody(w.shopB.id, w.product.id, 12));
    expect(res.statusCode).toBeLessThan(300);
    const purchase = await prisma.purchase.findFirstOrThrow({ where: { invoiceNumber: "INV-1" } });
    expect(purchase.shopId).toBe(w.shopB.id);
    expect(await branchQty(w.shopB.id, w.product.id)).toBe(12);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(0);
    expect(await aggregateIsConsistent(w.product.id)).toBe(true);

    // missing receiving branch is refused
    const bad = await call("POST", "/api/admin/purchases", w.central.token, purchaseBody(undefined, w.product.id, 1, "INV-2"));
    expect(bad.statusCode).toBe(422);

    // changing the selected shop later does not move or alter the purchase
    await call("POST", "/api/admin/shops/switch", w.central.token, { shopId: w.shopA.id });
    expect((await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } })).shopId).toBe(w.shopB.id);
  });

  it("#11 reversal is a linked record, negative movement, once only, and is blocked if stock would go negative", async () => {
    await call("POST", "/api/admin/purchases", w.central.token, purchaseBody(w.shopB.id, w.product.id, 5));
    const purchase = await prisma.purchase.findFirstOrThrow({ where: { invoiceNumber: "INV-1" } });

    // Blocked: sell 3 of 5, reversing 5 would make branch stock -3
    await sellCash(w.shopB.id, w.cashierB.id, w.product.id, 3, 100);
    const blocked = await call("POST", `/api/admin/purchases/${purchase.id}/reverse`, w.central.token, { reason: "wrong branch" });
    expect(blocked.statusCode).toBe(409);
    expect(json(blocked).code).toBe("PURCHASE_REVERSAL_BLOCKED");
    expect(await prisma.purchaseReversal.count()).toBe(0);
    expect(await branchQty(w.shopB.id, w.product.id)).toBe(2);

    // Fresh purchase, nothing sold -> reversal succeeds
    await call("POST", "/api/admin/purchases", w.central.token, purchaseBody(w.shopA.id, w.product.id, 4, "INV-3"));
    const p3 = await prisma.purchase.findFirstOrThrow({ where: { invoiceNumber: "INV-3" } });
    const ok = await call("POST", `/api/admin/purchases/${p3.id}/reverse`, w.central.token, { reason: "entered twice" });
    expect(ok.statusCode).toBeLessThan(300);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(0);
    expect(await prisma.purchaseReversal.count({ where: { purchaseId: p3.id } })).toBe(1);
    const original = await prisma.purchase.findUniqueOrThrow({ where: { id: p3.id }, include: { items: true } });
    expect(original.shopId).toBe(w.shopA.id); // original preserved, not edited
    expect(original.items).toHaveLength(1);
    expect(await prisma.inventoryMovement.count({ where: { productId: w.product.id, shopId: w.shopA.id, type: "OUT" } })).toBe(1);

    // second reversal refused
    const again = await call("POST", `/api/admin/purchases/${p3.id}/reverse`, w.central.token, { reason: "again" });
    expect(again.statusCode).toBe(409);
    expect(json(again).code).toBe("PURCHASE_ALREADY_REVERSED");
    expect(await aggregateIsConsistent(w.product.id)).toBe(true);
  });
});

describe.skipIf(!enabled)("Stage 2.9 — admin-only stock control", () => {
  const adj = (token: string, extra: Record<string, unknown> = {}) =>
    call("POST", "/api/admin/inventory/adjustments", token, {
      productId: w.product.id, adjustmentType: "add", quantity: 3, reason: "recount", ...extra,
    });

  it("#12 only the Central Admin can adjust stock, create products, branches, purchases; others get 403; unset ID fails closed", async () => {
    const before = await branchQty(w.other.shop.id, w.product.id);
    for (const [method, url, body] of [
      ["POST", "/api/admin/inventory/adjustments", { productId: w.product.id, adjustmentType: "add", quantity: 1, reason: "x" }],
      ["POST", "/api/admin/products", { name: "Sneaky", category: "x", sellingPrice: 1, stock: 0, unit: "piece", lowStockThreshold: 0 }],
      ["POST", "/api/admin/shops", { location: "Sneakyville" }],
      ["PUT", `/api/admin/branch-products/${w.product.id}/${w.shopA.id}`, { assigned: false }],
    ] as const) {
      const r = await call(method, url, w.other.token, body);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await branchQty(w.other.shop.id, w.product.id)).toBe(before);
    expect(await prisma.product.count({ where: { name: "Sneaky" } })).toBe(0);

    envMut.CENTRAL_ADMIN_USER_ID = undefined;
    const closed = await adj(w.central.token);
    expect(closed.statusCode).toBe(503); // fail closed: even the real Central Admin is refused
  });

  it("#13 a stock adjustment requires a reason, and writes a movement + keeps the aggregate", async () => {
    const noReason = await adj(w.central.token, { reason: "" });
    expect(noReason.statusCode).toBe(422);
    const missing = await call("POST", "/api/admin/inventory/adjustments", w.central.token, { productId: w.product.id, adjustmentType: "add", quantity: 3 });
    expect(missing.statusCode).toBe(422);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(0);

    const ok = await adj(w.central.token);
    expect(ok.statusCode).toBeLessThan(300);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(3);
    expect(await prisma.inventoryMovement.count({ where: { productId: w.product.id, type: "ADJUSTMENT" } })).toBe(1);
    expect(await aggregateIsConsistent(w.product.id)).toBe(true);

    // removing more than available is refused and changes nothing
    const tooMuch = await adj(w.central.token, { adjustmentType: "remove", quantity: 99 });
    expect(tooMuch.statusCode).toBeGreaterThanOrEqual(400);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(3);
  });
});

describe.skipIf(!enabled)("Stage 2.9 — billing & concurrency", () => {
  it("#14 a zero-stock product can never enter a bill", async () => {
    await expect(sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100)).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
    expect(await prisma.bill.count()).toBe(0);
  });

  it("#15 checkout refuses quantity above this branch's stock and changes nothing", async () => {
    await seedStock(w.shopA.id, w.product.id, 2);
    await seedStock(w.shopB.id, w.product.id, 50); // other branch's stock must NOT help
    await expect(sellCash(w.shopA.id, w.cashierA.id, w.product.id, 3, 100)).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(2);
    expect(await prisma.bill.count()).toBe(0);
  });

  it("#16 five concurrent sales of the last unit: exactly one succeeds, stock never negative", async () => {
    await seedStock(w.shopA.id, w.product.id, 1);
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100, { idempotencyKey: `race-${n}` }))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(0);
    expect(await productStock(w.product.id)).toBe(0);
    expect(await prisma.bill.count({ where: { status: "PAID" } })).toBe(1);
    expect(await aggregateIsConsistent(w.product.id)).toBe(true);
  });
});

describe.skipIf(!enabled)("Stage 2.9 — bill cancellation", () => {
  beforeEach(async () => {
    if (!enabled) return;
    await seedStock(w.shopA.id, w.product.id, 10);
    await seedStock(w.shopB.id, w.product.id, 10);
  });

  it("#17 cancellation needs a reason, restores stock to the bill's own branch, records actor/time, keeps the bill", async () => {
    const bill = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 4, 100);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(6);

    await expect(cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "   " })).rejects.toBeTruthy();
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PAID");

    const r = await call("POST", `/api/admin/bills/${bill.id}/cancel`, w.central.token, { reason: "customer returned goods" });
    expect(r.statusCode).toBeLessThan(300);

    const after = await prisma.bill.findUniqueOrThrow({ where: { id: bill.id }, include: { items: true } });
    expect(after.status).toBe("CANCELLED");
    expect(after.cancelledById).toBe(w.central.user.id);
    expect(after.cancelledAt).toBeTruthy();
    expect(after.cancelReason).toBe("customer returned goods");
    expect(after.items).toHaveLength(1); // original preserved
    expect(Number(after.items[0]!.unitPrice)).toBe(100);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(10); // restored to A
    expect(await branchQty(w.shopB.id, w.product.id)).toBe(10); // B untouched
    expect(await aggregateIsConsistent(w.product.id)).toBe(true);

    // cancelled amounts are excluded from net sales
    const paid = await prisma.bill.aggregate({ where: { shopId: w.shopA.id, status: "PAID" }, _sum: { grandTotal: true } });
    expect(Number(paid._sum.grandTotal ?? 0)).toBe(0);
  });

  it("#17 cancelling a bill from a CLOSED session is allowed and flagged", async () => {
    const bill = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100);
    await prisma.cashierSession.updateMany({ where: { cashierId: w.cashierA.id }, data: { status: "CLOSED" } });
    const r = await cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "late correction" });
    expect(r.cancelledAfterSessionClose).toBe(true);
  });

  it("#18 double and concurrent cancellation restore stock exactly once", async () => {
    const bill = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 3, 100);
    const results = await Promise.allSettled([
      cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "dup 1" }),
      cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "dup 2" }),
      cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "dup 3" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(10); // 7 + 3, not 13/16
    await expect(cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "again" })).rejects.toMatchObject({ code: "BILL_ALREADY_CANCELLED" });
    expect(await branchQty(w.shopA.id, w.product.id)).toBe(10);
  });

  it("#19 cancelling a credit bill reverses the customer balance once (transactional, idempotent)", async () => {
    const customer = await prisma.customer.create({ data: { shopId: w.shopA.id, cashierId: w.cashierA.id, name: "Credit Cust", phone: "9990002222" } });
    const bill = (await checkoutBill({
      shopId: w.shopA.id, cashierId: w.cashierA.id, customerId: customer.id,
      items: [{ productId: w.product.id, quantity: 2 }], payments: [{ method: "credit", amount: 200 }],
    })) as { id: string };
    expect(Number((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).creditBalance)).toBe(200);

    await Promise.allSettled([
      cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "wrong customer" }),
      cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "wrong customer (dup)" }),
    ]);
    expect(Number((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).creditBalance)).toBe(0);
    expect(await prisma.creditTransaction.count({ where: { billId: bill.id, type: "REVERSAL" } })).toBe(1);
  });

  it("#12 only the Central Admin can cancel a bill", async () => {
    const bill = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 1, 100);
    const r = await call("POST", `/api/admin/bills/${bill.id}/cancel`, w.other.token, { reason: "nope" });
    expect(r.statusCode).toBe(403);
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe("PAID");
  });
});

describe.skipIf(!enabled)("Stage 2.9 — authorization, reconciliation, data preservation", () => {
  it("#20 a Cashier sees only their branch's assigned products and cannot reach admin write routes", async () => {
    const hidden = await mkProduct(w.shopA.id, "Hidden At B Only");
    await prisma.branchProduct.update({
      where: { shopId_productId: { shopId: w.shopB.id, productId: hidden.id } },
      data: { isAssigned: false },
    });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "cashier-b@rbr.test", password: "Password123" } });
    expect(login.statusCode).toBe(200);
    const token = json(login).token as string;

    const list = await call("GET", "/api/products", token);
    expect(list.statusCode).toBe(200);
    expect(list.payload).toContain("Egg Tray");
    expect(list.payload).not.toContain("Hidden At B Only");

    const write = await call("POST", "/api/admin/inventory/adjustments", token, { productId: w.product.id, adjustmentType: "add", quantity: 1, reason: "x" });
    expect(write.statusCode).toBeGreaterThanOrEqual(401);
    expect(await branchQty(w.shopB.id, w.product.id)).toBe(0);

    // cashier B can never sell from branch A: checkout resolves stock by the cashier's own shopId
    await seedStock(w.shopA.id, w.product.id, 5);
    await expect(sellCash(w.shopB.id, w.cashierB.id, w.product.id, 1, 100)).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
  });

  it("#21 Product.stock equals SUM(branch quantities) after a mixed sequence of operations", async () => {
    await seedStock(w.shopA.id, w.product.id, 20);
    await seedStock(w.shopB.id, w.product.id, 15);
    const b1 = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 5, 100);
    await sellCash(w.shopB.id, w.cashierB.id, w.product.id, 4, 100);
    await call("POST", "/api/admin/inventory/adjustments", w.central.token, { productId: w.product.id, adjustmentType: "remove", quantity: 2, reason: "breakage" });
    await cancelBill({ billId: b1.id, actorId: w.central.user.id, reason: "test" });
    expect(await aggregateIsConsistent(w.product.id)).toBe(true);
    expect(await productStock(w.product.id)).toBe(20 - 2 + 15 - 4);
    expect(await prisma.branchInventory.count({ where: { quantity: { lt: 0 } } })).toBe(0);
  });

  it("#22 legacy data survives: product IDs, origin shopId, CashierInventory and movement history are untouched by Phase 2 operations", async () => {
    // Legacy row as it would exist before cutover
    await prisma.cashierInventory.create({ data: { shopId: w.shopA.id, cashierId: w.cashierA.id, productId: w.product.id, quantity: 5 } });
    await seedStock(w.shopA.id, w.product.id, 5);
    const before = await prisma.product.findUniqueOrThrow({ where: { id: w.product.id } });

    const bill = await sellCash(w.shopA.id, w.cashierA.id, w.product.id, 2, 100);
    await cancelBill({ billId: bill.id, actorId: w.central.user.id, reason: "preservation check" });
    await call("PUT", `/api/admin/branch-products/${w.product.id}/${w.shopA.id}`, w.central.token, { assigned: false });
    await call("PUT", `/api/admin/branch-products/${w.product.id}/${w.shopA.id}`, w.central.token, { assigned: true });

    const after = await prisma.product.findUniqueOrThrow({ where: { id: w.product.id } });
    expect(after.id).toBe(before.id);
    expect(after.shopId).toBe(before.shopId); // origin metadata preserved
    const legacy = await prisma.cashierInventory.findFirstOrThrow({ where: { productId: w.product.id } });
    expect(legacy.quantity).toBe(5); // read-only after cutover: no writes
    expect(await prisma.inventoryMovement.count({ where: { productId: w.product.id } })).toBeGreaterThanOrEqual(3); // seed, sale, restore
    expect(await prisma.bill.count({ where: { id: bill.id } })).toBe(1); // never deleted
  });
});
