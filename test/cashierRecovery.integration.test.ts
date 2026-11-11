/**
 * Integration tests for New Cashier Initialization and cashier data
 * isolation.
 *
 * Fixture rule (Stage 2.2): a product is visible/sellable at a branch only
 * through a BranchProduct row with isAssigned = true. Product.shopId is
 * legacy origin metadata and decides nothing. seedProducts() therefore
 * creates the BranchProduct rows for the branch it seeds.
 *
 * Inventory mode (system_flags 'inventory_source') decides which table is
 * authoritative, so the tests are mode-aware:
 *   CASHIER mode  — approval creates a zero-quantity CashierInventory row per
 *                   assigned product; stock is cashier-owned.
 *   BRANCH mode   — approval writes NO CashierInventory rows; stock is the
 *                   branch's BranchInventory, shared by the branch's cashier.
 * Tests for the mode that is not active are skipped, not failed.
 *
 * NOT run as part of the default sandboxed build. To run locally:
 *   1. Point DATABASE_URL (in .env.test) at a disposable Postgres database.
 *   2. npx prisma migrate deploy
 *   3. RUN_INTEGRATION_TESTS=1 npx vitest run test/cashierInitialization.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { adjustStock, getInventoryMode, type InventoryMode } from "../src/services/inventoryService.js";
import { resetDb } from "./dbReset.js";

let app: FastifyInstance;
let shopId: string;
let adminToken: string;
let mode: InventoryMode;

const PRODUCT_COUNT = 81;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  mode = await getInventoryMode(prisma);
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
 * other test files cover) so these tests focus on what approval and
 * inventory do. */
async function createApprovedCashier(email: string, shop: string) {
  return prisma.user.create({
    data: { name: "Cashier", email, passwordHash: await hashPassword("CashierPass123"), role: "CASHIER", status: "ACTIVE", shopId: shop },
  });
}

async function createPendingCashier(email: string, shop: string) {
  // Approval is exercised through the real HTTP endpoint so these tests
  // cover POST /admin/cashier-requests/:id/approve.
  return prisma.user.create({
    data: {
      name: "New Cashier",
      email,
      passwordHash: await hashPassword("CashierPass123"),
      role: "CASHIER",
      status: "PENDING_ADMIN_APPROVAL",
      shopId: shop,
    },
  });
}

async function approve(requestId: string, token: string) {
  return app.inject({
    method: "POST",
    url: `/api/admin/cashier-requests/${requestId}/approve`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/** Creates `count` catalog products AND assigns exactly those products to
 * `shop` (BranchProduct, isAssigned = true). Product.shopId is set only as
 * legacy origin metadata. */
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
  await prisma.branchProduct.createMany({
    data: ids.map((productId) => ({ shopId: shop, productId, isAssigned: true })),
    skipDuplicates: true,
  });
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

  // ── CASHIER mode (legacy, cashier-owned stock) ──────────────────────────

  it("[CASHIER mode] gives a newly-approved cashier a CashierInventory row at quantity 0 for every product assigned to the branch", async (ctx) => {
    if (mode !== "CASHIER") ctx.skip();
    const productIds = await seedProducts(shopId, PRODUCT_COUNT);
    const pending = await createPendingCashier("newcashier@example.com", shopId);

    const approveRes = await approve(pending.id, adminToken);
    expect(approveRes.statusCode).toBe(200);

    const rows = await prisma.cashierInventory.findMany({ where: { shopId, cashierId: pending.id } });
    expect(rows).toHaveLength(PRODUCT_COUNT);
    expect(rows.every((r) => r.quantity === 0)).toBe(true);
    expect(new Set(rows.map((r) => r.productId))).toEqual(new Set(productIds));
  });

  it("[CASHIER mode] does NOT copy an existing cashier's stock quantities onto a newly-approved cashier", async (ctx) => {
    if (mode !== "CASHIER") ctx.skip();
    const [productA] = await seedProducts(shopId, 1);
    const existingCashier = await createApprovedCashier("existing@example.com", shopId);

    await adjustStock(prisma, {
      shopId,
      cashierId: existingCashier.id,
      productId: productA,
      delta: 500,
      type: "IN",
      reason: "test seed",
    });

    const pending = await createPendingCashier("newcashier2@example.com", shopId);
    await approve(pending.id, adminToken);

    const newCashierRow = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: pending.id, productId: productA } },
    });
    expect(newCashierRow?.quantity).toBe(0);

    const existingRow = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: existingCashier.id, productId: productA } },
    });
    expect(existingRow?.quantity).toBe(500);
  });

  it("[CASHIER mode] a new cashier's catalog (GET /products) includes every assigned product, all at stock 0", async (ctx) => {
    if (mode !== "CASHIER") ctx.skip();
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

    const pending = await createPendingCashier("newcashier3@example.com", shopId);
    await approve(pending.id, adminToken);

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

  it("[CASHIER mode] does not affect an existing cashier's inventory when a different new cashier is approved in the same shop", async (ctx) => {
    if (mode !== "CASHIER") ctx.skip();
    const [productA] = await seedProducts(shopId, 1);
    const existingCashier = await createApprovedCashier("existing3@example.com", shopId);
    await adjustStock(prisma, { shopId, cashierId: existingCashier.id, productId: productA, delta: 80, type: "IN", reason: "seed" });

    const before = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: existingCashier.id, productId: productA } },
    });

    const pending = await createPendingCashier("newcashier4@example.com", shopId);
    await approve(pending.id, adminToken);

    const after = await prisma.cashierInventory.findUnique({
      where: { shopId_cashierId_productId: { shopId, cashierId: existingCashier.id, productId: productA } },
    });
    expect(after?.quantity).toBe(before?.quantity);
  });

  it("[CASHIER mode] two different branches: each new cashier gets only their own branch's assigned products, all at 0", async (ctx) => {
    if (mode !== "CASHIER") ctx.skip();
    await seedProducts(shopId, 5); // Chennai

    const bengaluru = await prisma.shop.create({ data: { name: "RBR Egg Mart - Bengaluru", code: "bengaluru" } });
    await seedProducts(bengaluru.id, 5);
    const bengaluruAdmin = await createAdmin("admin-blr@eggmart.test", bengaluru.id);

    const pendingChennai = await createPendingCashier("chennai-cashier@example.com", shopId);
    const pendingBengaluru = await createPendingCashier("bengaluru-cashier@example.com", bengaluru.id);

    await approve(pendingChennai.id, adminToken);
    await approve(pendingBengaluru.id, bengaluruAdmin.token);

    const chennaiRows = await prisma.cashierInventory.findMany({ where: { shopId, cashierId: pendingChennai.id } });
    const bengaluruRows = await prisma.cashierInventory.findMany({ where: { shopId: bengaluru.id, cashierId: pendingBengaluru.id } });

    expect(chennaiRows).toHaveLength(5);
    expect(bengaluruRows).toHaveLength(5);
    expect(chennaiRows.every((r) => r.quantity === 0)).toBe(true);
    expect(bengaluruRows.every((r) => r.quantity === 0)).toBe(true);
    // Branch isolation: no overlap between the two branches' products.
    const chennaiIds = new Set(chennaiRows.map((r) => r.productId));
    expect(bengaluruRows.some((r) => chennaiIds.has(r.productId))).toBe(false);
  });

  it("[CASHIER mode] a product UNASSIGNED from the branch gets no row for a new cashier", async (ctx) => {
    if (mode !== "CASHIER") ctx.skip();
    const [keep, hidden] = await seedProducts(shopId, 2);
    await prisma.branchProduct.update({
      where: { shopId_productId: { shopId, productId: hidden } },
      data: { isAssigned: false },
    });

    const pending = await createPendingCashier("newcashier5@example.com", shopId);
    await approve(pending.id, adminToken);

    const rows = await prisma.cashierInventory.findMany({ where: { shopId, cashierId: pending.id } });
    expect(rows.map((r) => r.productId)).toEqual([keep]);
  });

  // ── BRANCH mode (authoritative: BranchInventory) ────────────────────────

  it("[BRANCH mode] approval writes NO CashierInventory rows", async (ctx) => {
    if (mode !== "BRANCH") ctx.skip();
    await seedProducts(shopId, 5);
    const pending = await createPendingCashier("newcashier6@example.com", shopId);

    const approveRes = await approve(pending.id, adminToken);
    expect(approveRes.statusCode).toBe(200);

    expect(await prisma.cashierInventory.count({ where: { shopId } })).toBe(0);
  });

  it("[BRANCH mode] the branch's cashier sees the branch's stock, and unstocked assigned products at 0", async (ctx) => {
    if (mode !== "BRANCH") ctx.skip();
    const [stocked, ...rest] = await seedProducts(shopId, 3);
    await adjustStock(prisma, { shopId, productId: stocked, delta: 40, type: "IN", reason: "seed" });

    const pending = await createPendingCashier("newcashier7@example.com", shopId);
    await approve(pending.id, adminToken);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "newcashier7@example.com", password: "CashierPass123" },
    });
    const token = JSON.parse(loginRes.payload).token as string;

    const res = await app.inject({ method: "GET", url: "/api/products", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const products = JSON.parse(res.payload) as Array<{ id: string; stock: number }>;

    expect(products).toHaveLength(3);
    expect(products.find((p) => p.id === stocked)?.stock).toBe(40);
    for (const id of rest) expect(products.find((p) => p.id === id)?.stock).toBe(0);
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

  it("[CASHIER mode] Cashier A cannot see Cashier B's stock through the product catalog endpoint", async (ctx) => {
    if (mode !== "CASHIER") ctx.skip();
    const [productA] = await seedProducts(shopId, 1);
    await createApprovedCashier("cashierA@example.com", shopId);
    const cashierB = await createApprovedCashier("cashierB@example.com", shopId);

    await adjustStock(prisma, { shopId, cashierId: cashierB.id, productId: productA, delta: 300, type: "IN", reason: "seed" });

    const loginA = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "cashierA@example.com", password: "CashierPass123" } });
    const tokenA = JSON.parse(loginA.payload).token as string;

    const productsRes = await app.inject({ method: "GET", url: "/api/products", headers: { authorization: `Bearer ${tokenA}` } });
    const products = JSON.parse(productsRes.payload) as Array<{ id: string; stock: number }>;
    const seen = products.find((p) => p.id === productA);

    // Cashier A sees the product (shared branch catalog) but at THEIR OWN
    // stock (0), never Cashier B's 300.
    expect(seen).toBeDefined();
    expect(seen?.stock).toBe(0);
  });

  it("a cashier at another branch cannot see this branch's products", async () => {
    const [productA] = await seedProducts(shopId, 1);

    const other = await prisma.shop.create({ data: { name: "RBR Egg Mart - Bengaluru", code: "bengaluru" } });
    await createApprovedCashier("other-cashier@example.com", other.id);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "other-cashier@example.com", password: "CashierPass123" } });
    const token = JSON.parse(login.payload).token as string;

    const res = await app.inject({ method: "GET", url: "/api/products", headers: { authorization: `Bearer ${token}` } });
    const products = JSON.parse(res.payload) as Array<{ id: string }>;
    expect(products.some((p) => p.id === productA)).toBe(false);
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
