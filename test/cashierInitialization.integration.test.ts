/**
 * Integration tests for RBR Egg Mart V2 Phase 1 — New Cashier
 * Initialization: a newly-approved cashier gets the shop's full (shared)
 * product catalog, a fresh CashierInventory row per product at quantity
 * 0, and none of another cashier's existing stock, customers, or history.
 *
 * NOT run as part of the default sandboxed build. To run locally:
 *   1. Point DATABASE_URL (in .env) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/cashierInitialization.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { adjustStock } from "../src/services/inventoryService.js";
import { resetDb } from "./dbReset.js";

let app: FastifyInstance;
let shopId: string;
let adminToken: string;

const PRODUCT_COUNT = 81;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function createAdmin(email: string, shop: string) {
  const admin = await prisma.user.create({
    data: { name: "Admin", email, passwordHash: await hashPassword("AdminPass123"), role: "ADMIN", status: "ACTIVE", shopId: shop },
  });
  const res = await app.inject({ method: "POST", url: "/api/auth/admin/login", payload: { email, password: "AdminPass123" } });
  return { id: admin.id, token: JSON.parse(res.payload).token as string };
}

/** Approved cashier, created directly (bypassing signup/invitation, which
 * other test files already cover) so these tests can focus purely on
 * what approval does to CashierInventory. */
async function createApprovedCashier(email: string, shop: string) {
  return prisma.user.create({
    data: { name: "Cashier", email, passwordHash: await hashPassword("CashierPass123"), role: "CASHIER", status: "ACTIVE", shopId: shop },
  });
}

async function createPendingCashierViaApi(email: string, branchNameShopId: string) {
  // Approval is exercised through the real HTTP endpoint (not a direct
  // Prisma write) so these tests cover the exact code path Objective 1
  // targets: POST /admin/cashier-requests/:id/approve.
  const pending = await prisma.user.create({
    data: {
      name: "New Cashier",
      email,
      passwordHash: await hashPassword("CashierPass123"),
      role: "CASHIER",
      status: "PENDING_ADMIN_APPROVAL",
      shopId: branchNameShopId,
    },
  });
  return pending;
}

async function seedProducts(shop: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = await prisma.product.create({
      data: {
        shopId: shop,
        name: `Product ${i}`,
        category: "General",
        sellingPrice: 10,
        unit: "PIECE",
      },
    });
    ids.push(p.id);
  }
  return ids;
}

describe("New Cashier Initialization", () => {
  beforeEach(async () => {
    await resetDb();
    const shop = await prisma.shop.create({ data: { name: "RBR Egg Mart - Chennai", code: "chennai" } });
    shopId = shop.id;
    const admin = await createAdmin("admin@eggmart.test", shopId);
    adminToken = admin.token;
  });

  it("gives a newly-approved cashier a CashierInventory row at quantity 0 for every product already in the shop's catalog", async () => {
    const productIds = await seedProducts(shopId, PRODUCT_COUNT);
    const pending = await createPendingCashierViaApi("newcashier@example.com", shopId);

    const approveRes = await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${pending.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(approveRes.statusCode).toBe(200);

    const rows = await prisma.cashierInventory.findMany({ where: { shopId, cashierId: pending.id } });
    expect(rows).toHaveLength(PRODUCT_COUNT);
    expect(rows.every((r) => r.quantity === 0)).toBe(true);
    expect(new Set(rows.map((r) => r.productId))).toEqual(new Set(productIds));
  });

  it("does NOT copy an existing cashier's stock quantities onto a newly-approved cashier", async () => {
    const [productA] = await seedProducts(shopId, 1);
    const existingCashier = await createApprovedCashier("existing@example.com", shopId);

    // Existing cashier has real stock.
    await adjustStock(prisma, {
      shopId,
      cashierId: existingCashier.id,
      productId: productA,
      delta: 500,
      type: "IN",
      reason: "test seed",
    });

    const pending = await createPendingCashierViaApi("newcashier2@example.com", shopId);
    await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${pending.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const newCashierRow = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: pending.id, productId: productA } },
    });
    expect(newCashierRow?.quantity).toBe(0);

    // Existing cashier's own stock is untouched.
    const existingRow = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: existingCashier.id, productId: productA } },
    });
    expect(existingRow?.quantity).toBe(500);
  });

  it("a new cashier's product catalog (GET /products) includes every shop product, all at stock 0", async () => {
    await seedProducts(shopId, PRODUCT_COUNT);
    const existingCashier = await createApprovedCashier("existing2@example.com", shopId);
    const [firstProduct] = await prisma.product.findMany({ where: { shopId }, take: 1 });
    await adjustStock(prisma, {
      shopId,
      cashierId: existingCashier.id,
      productId: firstProduct.id,
      delta: 250,
      type: "IN",
      reason: "test seed",
    });

    const pending = await createPendingCashierViaApi("newcashier3@example.com", shopId);
    await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${pending.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "newcashier3@example.com", password: "CashierPass123" },
    });
    const newCashierToken = JSON.parse(loginRes.payload).token as string;

    const productsRes = await app.inject({
      method: "GET",
      url: "/api/products",
      headers: { authorization: `Bearer ${newCashierToken}` },
    });
    expect(productsRes.statusCode).toBe(200);
    const products = JSON.parse(productsRes.payload) as Array<{ id: string; stock: number }>;

    expect(products).toHaveLength(PRODUCT_COUNT);
    expect(products.every((p) => p.stock === 0)).toBe(true);
  });

  it("does not affect an existing cashier's inventory when a different new cashier is approved in the same shop", async () => {
    const [productA] = await seedProducts(shopId, 1);
    const existingCashier = await createApprovedCashier("existing3@example.com", shopId);
    await adjustStock(prisma, { shopId, cashierId: existingCashier.id, productId: productA, delta: 80, type: "IN", reason: "seed" });

    const before = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: existingCashier.id, productId: productA } },
    });

    const pending = await createPendingCashierViaApi("newcashier4@example.com", shopId);
    await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${pending.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const after = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: existingCashier.id, productId: productA } },
    });
    expect(after?.quantity).toBe(before?.quantity);
  });

  it("two different branches: each new cashier gets their own branch's full catalog, still all at 0", async () => {
    await seedProducts(shopId, 5); // Chennai

    const bengaluru = await prisma.shop.create({ data: { name: "RBR Egg Mart - Bengaluru", code: "bengaluru" } });
    await seedProducts(bengaluru.id, 5);
    const bengaluruAdmin = await createAdmin("admin-blr@eggmart.test", bengaluru.id);

    const pendingChennai = await createPendingCashierViaApi("chennai-cashier@example.com", shopId);
    const pendingBengaluru = await createPendingCashierViaApi("bengaluru-cashier@example.com", bengaluru.id);

    await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${pendingChennai.id}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/cashier-requests/${pendingBengaluru.id}/approve`,
      headers: { authorization: `Bearer ${bengaluruAdmin.token}` },
    });

    const chennaiRows = await prisma.cashierInventory.findMany({ where: { shopId, cashierId: pendingChennai.id } });
    const bengaluruRows = await prisma.cashierInventory.findMany({ where: { shopId: bengaluru.id, cashierId: pendingBengaluru.id } });

    expect(chennaiRows).toHaveLength(5);
    expect(bengaluruRows).toHaveLength(5);
    expect(chennaiRows.every((r) => r.quantity === 0)).toBe(true);
    expect(bengaluruRows.every((r) => r.quantity === 0)).toBe(true);
  });
});

describe("Cashier data isolation (security regression)", () => {
  beforeEach(async () => {
    await resetDb();
    const shop = await prisma.shop.create({ data: { name: "RBR Egg Mart - Chennai", code: "chennai" } });
    shopId = shop.id;
    const admin = await createAdmin("admin2@eggmart.test", shopId);
    adminToken = admin.token;
  });

  it("Cashier A cannot see Cashier B's stock through the product catalog endpoint", async () => {
    const [productA] = await seedProducts(shopId, 1);
    const cashierA = await createApprovedCashier("cashierA@example.com", shopId);
    const cashierB = await createApprovedCashier("cashierB@example.com", shopId);

    await adjustStock(prisma, { shopId, cashierId: cashierB.id, productId: productA, delta: 300, type: "IN", reason: "seed" });

    const loginA = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "cashierA@example.com", password: "CashierPass123" } });
    const tokenA = JSON.parse(loginA.payload).token as string;

    const productsRes = await app.inject({ method: "GET", url: "/api/products", headers: { authorization: `Bearer ${tokenA}` } });
    const products = JSON.parse(productsRes.payload) as Array<{ id: string; stock: number }>;
    const seen = products.find((p) => p.id === productA);

    // Cashier A sees the product (shared catalog) but at THEIR OWN stock
    // (0), never Cashier B's 300.
    expect(seen?.stock).toBe(0);
  });

  it("a cashier cannot adjust another cashier's inventory by supplying their own id as cashierId to the admin adjust-stock endpoint (auth-only sanity check)", async () => {
    const [productA] = await seedProducts(shopId, 1);
    const cashierA = await createApprovedCashier("cashierA2@example.com", shopId);

    const loginA = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "cashierA2@example.com", password: "CashierPass123" } });
    const tokenA = JSON.parse(loginA.payload).token as string;

    // Cashiers have no route access to the admin inventory-adjustment
    // endpoint at all — role gating should reject this outright.
    const res = await app.inject({
      method: "PATCH",
      url: `/api/admin/products/${productA}/adjust-stock`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { delta: 999, cashierId: cashierA.id },
    });
    expect(res.statusCode).toBe(403);
  });
});
