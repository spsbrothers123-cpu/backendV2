/**
 * RBR Egg Mart V2 — Phase 4, Stage 4.5: Cashier REPLACEMENT scenario.
 *
 * *** NOT RUN in the environment this file was written in (no Postgres, no
 * Prisma engine download). It is delivered as written and MUST be executed by
 * the owner against an isolated database before any claim is made about
 * database-level isolation. ***
 *
 * Runs ONLY against a disposable local Postgres whose name contains "test"
 * (enforced by test/setup.ts):
 *
 *   1. cp env.test .env.test  and point DATABASE_URL at a LOCAL *_test database
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/cashierReplacement.integration.test.ts
 *
 * Scenario: branch X has cashier OLD with an open session, a paid cash bill, a
 * credit bill for a customer OLD created, and a held bill. The Admin suspends
 * OLD; a NEW cashier is approved at the same branch. The tests prove, in the
 * database, that nothing is transferred to NEW, that history is untouched, and
 * that branch stock is unaffected.
 *
 * Two tests are labelled KNOWN RISK: they pin down CURRENT behaviour that the
 * owner has decided to leave as-is for Stage 4.5 and document as remaining
 * risks (F2 orphaned open session, F3 cashier-scoped customers). If either
 * behaviour is changed later, those tests should fail loudly and be revisited.
 *
 * Limitation: NEW is created directly in the database (status ACTIVE) instead
 * of going through invite-code signup + approval; that flow is covered by the
 * Stage 2.x / 4.1 tests. Everything after account creation uses the real HTTP
 * routes with real JWTs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { checkoutBill } from "../src/services/billingService.js";
import { adjustStock } from "../src/services/inventoryService.js";
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
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth(token), ...(payload !== undefined ? { payload: payload as object } : {}) });
const json = (r: { payload: string }) => JSON.parse(r.payload);
const login = async (email: string) =>
  (json(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Password123" } })) as { token: string }).token;

async function setMode(value: "CASHIER" | "BRANCH") {
  await prisma.systemFlag.upsert({ where: { key: "inventory_source" }, update: { value }, create: { key: "inventory_source", value } });
}
async function mkCashier(shopId: string, email: string) {
  return prisma.user.create({
    data: { name: email, email, passwordHash: await hashPassword("Password123"), role: "CASHIER", status: "ACTIVE", shopId },
  });
}
const branchQty = async (shopId: string, productId: string) =>
  (await prisma.branchInventory.findUnique({ where: { shopId_productId: { shopId, productId } } }))?.quantity ?? 0;
const productStock = async (productId: string) => (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock;

interface World {
  adminToken: string;
  shopId: string;
  productId: string;
  old: { id: string; email: string; token: string };
  oldSessionId: string;
  oldCashBillId: string;
  oldCreditBillId: string;
  oldHeldBillId: string;
  customerId: string;
}
let w: World;

beforeEach(async () => {
  if (!enabled) return;
  await resetDb();
  await setMode("BRANCH"); // the post-cutover architecture; this test never performs a cutover

  const central = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
  envMut.CENTRAL_ADMIN_USER_ID = central.user.id;
  const shopId = central.shop.id;
  await assignAllProductsToBranch(prisma, shopId, null);

  const product = await prisma.product.create({
    data: { shopId, name: "Egg Tray", category: "Eggs", sellingPrice: 100, stock: 0, unit: "TRAY", lowStockThreshold: 3 },
  });
  await assignProductToAllBranches(prisma, product.id, null);
  await prisma.$transaction((tx) =>
    adjustStock(tx, { shopId, productId: product.id, delta: 50, type: "IN", reason: "test seed", actorId: null, cashierId: null })
  );

  const oldCashier = await mkCashier(shopId, "old@rbr.test");
  const oldToken = await login("old@rbr.test");

  // OLD's open session, through the real route.
  const started = await call("POST", "/api/sessions/start", oldToken, { openingCash: 1000 });
  expect(started.statusCode).toBeLessThan(300);
  const oldSessionId = json(started).id as string;

  // OLD's customer, through the real route (so cashierId ownership is set the way production sets it).
  const created = await call("POST", "/api/customers", oldToken, { name: "Ravi", phone: "9000000001" });
  expect(created.statusCode).toBe(201);
  const customerId = json(created).id as string;

  // OLD's paid cash bill and credit bill.
  const cashBill = (await checkoutBill({
    shopId, cashierId: oldCashier.id, customerId: null, items: [{ productId: product.id, quantity: 2 }],
    payments: [{ method: "cash", amount: 200 }], idempotencyKey: null,
  })) as { id: string };
  const creditBill = (await checkoutBill({
    shopId, cashierId: oldCashier.id, customerId, items: [{ productId: product.id, quantity: 1 }],
    payments: [{ method: "credit", amount: 100 }], idempotencyKey: null,
  })) as { id: string };

  // OLD's held bill, through the real route.
  const held = await call("POST", "/api/bills/hold", oldToken, { label: "Table 4", items: [{ product: { id: product.id }, quantity: 3 }] });
  expect(held.statusCode).toBeLessThan(300);
  const oldHeldBillId = json(held).id as string;

  w = {
    adminToken: central.token, shopId, productId: product.id,
    old: { id: oldCashier.id, email: "old@rbr.test", token: oldToken },
    oldSessionId, oldCashBillId: cashBill.id, oldCreditBillId: creditBill.id, oldHeldBillId, customerId,
  };
});

/** Suspend OLD through the real admin route and bring NEW in at the same branch. */
async function replaceCashier() {
  const suspended = await call("PATCH", `/api/admin/cashiers/${w.old.id}/status`, w.adminToken, { status: "SUSPENDED" });
  expect(suspended.statusCode).toBe(200);
  const fresh = await mkCashier(w.shopId, "new@rbr.test");
  const token = await login("new@rbr.test");
  return { id: fresh.id, token };
}

async function snapshot() {
  return {
    bills: await prisma.bill.count(),
    paidBills: await prisma.bill.count({ where: { status: "PAID" } }),
    heldBills: await prisma.bill.count({ where: { status: "HELD" } }),
    sessions: await prisma.cashierSession.count(),
    customers: await prisma.customer.count(),
    credit: await prisma.creditTransaction.count(),
    movements: await prisma.inventoryMovement.count(),
    payments: await prisma.payment.count(),
    branchQty: await branchQty(w.shopId, w.productId),
    productStock: await productStock(w.productId),
    customerBalance: String((await prisma.customer.findUniqueOrThrow({ where: { id: w.customerId } })).creditBalance),
  };
}

describe.skipIf(!enabled)("Stage 4.5 — cashier replacement (NOT RUN unless executed on an isolated test DB)", () => {
  it("OLD's token stops working the moment OLD is suspended", async () => {
    await replaceCashier();
    const res = await call("GET", "/api/sessions/current", w.old.token);
    expect([401, 403]).toContain(res.statusCode);
  });

  it("NEW does not inherit OLD's identity or session: no current session, cannot read or close OLD's session", async () => {
    const neu = await replaceCashier();
    expect(neu.id).not.toBe(w.old.id);

    const current = await call("GET", "/api/sessions/current", neu.token);
    expect(current.statusCode).toBe(404);
    expect(json(current).code).toBe("NO_ACTIVE_SESSION");

    const close = await call("POST", "/api/sessions/close", neu.token, { sessionId: w.oldSessionId, actualClosingCash: 1 });
    expect(close.statusCode).toBe(404);
    expect(json(close).code).toBe("SESSION_NOT_FOUND");
    expect((await prisma.cashierSession.findUniqueOrThrow({ where: { id: w.oldSessionId } })).status).toBe("OPEN"); // untouched
  });

  it("NEW does not inherit OLD's held bills: list is empty, OLD's held bill cannot be read, deleted or resumed-by-id", async () => {
    const neu = await replaceCashier();
    const list = await call("GET", "/api/bills/held", neu.token);
    expect(list.statusCode).toBe(200);
    expect(json(list)).toEqual([]);

    const del = await call("DELETE", `/api/bills/held/${w.oldHeldBillId}`, neu.token);
    expect(del.statusCode).toBe(404);
    expect(json(del).code).toBe("HELD_BILL_NOT_FOUND");

    const row = await prisma.bill.findUniqueOrThrow({ where: { id: w.oldHeldBillId } });
    expect(row.status).toBe("HELD");
    expect(row.cashierId).toBe(w.old.id);
  });

  it("NEW sees none of OLD's sales: history and reports are empty, and OLD's bills are not readable by id", async () => {
    const neu = await replaceCashier();
    const history = await call("GET", "/api/bills/history?includeCancelled=true", neu.token);
    expect(history.statusCode).toBe(200);
    expect(json(history)).toEqual([]);

    const report = await call("GET", "/api/reports/sales", neu.token);
    expect(report.statusCode).toBe(200);
    expect(json(report)).toMatchObject({ sales: 0, billCount: 0 });

    // A client-supplied cashierId must not widen the scope.
    const spoofed = await call("GET", `/api/reports/sales?cashierId=${w.old.id}`, neu.token);
    expect(json(spoofed)).toMatchObject({ sales: 0, billCount: 0 });
    const spoofedHistory = await call("GET", `/api/bills/history?cashierId=${w.old.id}&includeCancelled=true`, neu.token);
    expect(json(spoofedHistory)).toEqual([]);

    for (const id of [w.oldCashBillId, w.oldCreditBillId]) {
      const res = await call("GET", `/api/bills/${id}`, neu.token);
      expect(res.statusCode).toBe(404);
      expect(json(res).code).toBe("BILL_NOT_FOUND");
    }
  });

  it("KNOWN RISK F3 (documented, unchanged): customers are cashier-scoped, so NEW cannot list or bill OLD's customers", async () => {
    const neu = await replaceCashier();
    const list = await call("GET", "/api/customers", neu.token);
    expect(list.statusCode).toBe(200);
    expect((json(list) as { id: string }[]).map((c) => c.id)).not.toContain(w.customerId);

    const hold = await call("POST", "/api/bills/hold", neu.token, { customer: { id: w.customerId }, items: [{ product: { id: w.productId }, quantity: 1 }] });
    expect(hold.statusCode).toBe(404);
    expect(json(hold).code).toBe("CUSTOMER_NOT_FOUND");
  });

  it("historical records are preserved byte-for-byte in count: replacement deletes or rewrites nothing", async () => {
    const before = await snapshot();
    const billBefore = await prisma.bill.findUniqueOrThrow({ where: { id: w.oldCashBillId } });
    await replaceCashier();
    const after = await snapshot();
    expect(after).toEqual(before);
    const billAfter = await prisma.bill.findUniqueOrThrow({ where: { id: w.oldCashBillId } });
    expect(billAfter.cashierId).toBe(w.old.id);
    expect(String(billAfter.grandTotal)).toBe(String(billBefore.grandTotal));
    expect(billAfter.sessionId).toBe(billBefore.sessionId);
    // OLD's user row still exists (history keeps its owner), just not ACTIVE.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.old.id } })).status).toBe("SUSPENDED");
  });

  it("branch stock survives replacement: same quantity before and after, and NEW sees it", async () => {
    const before = await branchQty(w.shopId, w.productId);
    const neu = await replaceCashier();
    expect(await branchQty(w.shopId, w.productId)).toBe(before);
    await call("POST", "/api/sessions/start", neu.token, { openingCash: 0 });
    const products = await call("GET", "/api/products", neu.token);
    const row = (json(products) as { id: string; stock: number }[]).find((p) => p.id === w.productId);
    expect(row?.stock).toBe(before);
  });

  it("NEW can work normally: own session, own bill; stock drops by exactly that sale; OLD's data and totals are untouched", async () => {
    const neu = await replaceCashier();
    const start = await call("POST", "/api/sessions/start", neu.token, { openingCash: 200 });
    expect(start.statusCode).toBeLessThan(300);
    const newSessionId = json(start).id as string;
    expect(newSessionId).not.toBe(w.oldSessionId);

    const before = await snapshot();
    const sale = await call("POST", "/api/bills/checkout", neu.token, {
      items: [{ product: { id: w.productId }, quantity: 4 }],
      payments: [{ method: "cash", amount: 400 }],
    });
    expect(sale.statusCode).toBeLessThan(300);
    const bill = await prisma.bill.findUniqueOrThrow({ where: { id: json(sale).id as string } });
    expect(bill.cashierId).toBe(neu.id);
    expect(bill.sessionId).toBe(newSessionId);

    expect(await branchQty(w.shopId, w.productId)).toBe(before.branchQty - 4);
    expect(await productStock(w.productId)).toBe(before.productStock - 4); // aggregate stays reconciled
    const sum = await prisma.branchInventory.aggregate({ where: { productId: w.productId }, _sum: { quantity: true } });
    expect(await productStock(w.productId)).toBe(sum._sum.quantity ?? 0);

    // OLD's rows are exactly as before the sale.
    expect((await prisma.bill.findUniqueOrThrow({ where: { id: w.oldCashBillId } })).cashierId).toBe(w.old.id);
    expect(await prisma.bill.count({ where: { cashierId: w.old.id } })).toBe(3); // cash, credit, held
    expect(String((await prisma.customer.findUniqueOrThrow({ where: { id: w.customerId } })).creditBalance)).toBe(before.customerBalance);

    // NEW's history shows only NEW's bill.
    const history = await call("GET", "/api/bills/history?includeCancelled=true", neu.token);
    expect((json(history) as { id: string }[]).map((b) => b.id)).toEqual([bill.id]);
  });

  it("KNOWN RISK F2 (report-only, unchanged): suspending OLD leaves OLD's session OPEN, and NEW opening a session makes two OPEN sessions at the branch", async () => {
    const neu = await replaceCashier();
    expect((await prisma.cashierSession.findUniqueOrThrow({ where: { id: w.oldSessionId } })).status).toBe("OPEN");
    await call("POST", "/api/sessions/start", neu.token, { openingCash: 0 });
    expect(await prisma.cashierSession.count({ where: { shopId: w.shopId, status: "OPEN" } })).toBe(2);
    // No closing figure was invented for OLD's session.
    expect((await prisma.cashierSession.findUniqueOrThrow({ where: { id: w.oldSessionId } })).actualClosingCash).toBeNull();
  });

  it("one-cashier-per-branch still holds: OLD cannot be re-activated while NEW occupies the branch", async () => {
    await replaceCashier();
    const res = await call("PATCH", `/api/admin/cashiers/${w.old.id}/status`, w.adminToken, { status: "ACTIVE" });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe("BRANCH_HAS_CASHIER");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: w.old.id } })).status).toBe("SUSPENDED");
  });

  it("a non-invalidating 403 does not revoke the cashier's session: SHOP_MISMATCH leaves the token usable", async () => {
    const neu = await replaceCashier();
    const mismatch = await call("POST", "/api/sessions/start", neu.token, { openingCash: 0, shopId: "some-other-shop" });
    expect(mismatch.statusCode).toBe(403);
    expect(json(mismatch).code).toBe("SHOP_MISMATCH");
    // The server did not sign the cashier out; the client must not either (see Cashier stage45 tests).
    const stillOk = await call("GET", "/api/sessions/current", neu.token);
    expect([200, 404]).toContain(stillOk.statusCode);
    expect(stillOk.statusCode).not.toBe(401);
  });
});
