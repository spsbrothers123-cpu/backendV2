/**
 * RBR Egg Mart V2 — Phase 3, Stage 3.3: `inventoryRecorded` on the three
 * additive endpoints.
 *
 *   GET /api/admin/inventory
 *   GET /api/admin/products
 *   GET /api/admin/inventory/:productId/by-cashier
 *
 * Runs ONLY against a disposable local Postgres whose name contains "test"
 * (enforced by test/setup.ts), with inventory_source = BRANCH:
 *
 *   RUN_INTEGRATION_TESTS=1 npx vitest run test/inventoryRecorded.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { assignProductToAllBranches } from "../src/lib/branchCatalog.js";
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

const call = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const json = (r: { payload: string }) => JSON.parse(r.payload);

async function setBranchMode() {
  await prisma.systemFlag.upsert({
    where: { key: "inventory_source" },
    update: { value: "BRANCH" },
    create: { key: "inventory_source", value: "BRANCH" },
  });
}

let central: Awaited<ReturnType<typeof createAdminFixture>>;
let other: Awaited<ReturnType<typeof createAdminFixture>>;
let productId: string;

beforeEach(async () => {
  if (!enabled) return;
  await resetDb();
  await setBranchMode();
  central = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
  envMut.CENTRAL_ADMIN_USER_ID = central.user.id;
  other = await createAdminFixture(app, { email: "other@rbr.test", shopLocation: "Palladam" });
  const p = await prisma.product.create({
    data: { shopId: central.shop.id, name: "Egg Tray", category: "Eggs", sellingPrice: 100, stock: 0, unit: "TRAY", lowStockThreshold: 1 },
  });
  await assignProductToAllBranches(prisma, p.id, null);
  productId = p.id;
});

const adjust = (token: string, adjustmentType: "add" | "remove", quantity: number) =>
  call("POST", "/api/admin/inventory/adjustments", token, { productId, adjustmentType, quantity, reason: "Stock count correction" });

const fromInventory = async (token: string) =>
  json(await call("GET", "/api/admin/inventory?pageSize=50", token)).items.find((i: { id: string }) => i.id === productId);
const fromProducts = async (token: string) =>
  json(await call("GET", "/api/admin/products?pageSize=50", token)).items.find((i: { id: string }) => i.id === productId);
const fromByCashier = async (token: string) => json(await call("GET", `/api/admin/inventory/${productId}/by-cashier`, token));

describe.skipIf(!enabled)("Stage 3.3 — inventoryRecorded", () => {
  it("is false on all three endpoints when the branch has never had a BranchInventory row", async () => {
    expect(await prisma.branchInventory.count({ where: { shopId: central.shop.id, productId } })).toBe(0);
    const inv = await fromInventory(central.token);
    const prod = await fromProducts(central.token);
    const bc = await fromByCashier(central.token);
    expect(inv).toMatchObject({ stock: 0, inventoryRecorded: false });
    expect(prod).toMatchObject({ stock: 0, inventoryRecorded: false });
    expect(bc).toMatchObject({ branchStock: 0, inventoryRecorded: false });
  });

  it("is true once a row exists — including a genuine zero left after add then remove", async () => {
    expect((await adjust(central.token, "add", 5)).statusCode).toBeLessThan(300);
    expect(await fromInventory(central.token)).toMatchObject({ stock: 5, inventoryRecorded: true });

    expect((await adjust(central.token, "remove", 5)).statusCode).toBeLessThan(300);
    const row = await prisma.branchInventory.findUniqueOrThrow({ where: { shopId_productId: { shopId: central.shop.id, productId } } });
    expect(row.quantity).toBe(0);

    // Same quantity (0) as the "never stocked" case, opposite flag.
    expect(await fromInventory(central.token)).toMatchObject({ stock: 0, inventoryRecorded: true });
    expect(await fromProducts(central.token)).toMatchObject({ stock: 0, inventoryRecorded: true });
    expect(await fromByCashier(central.token)).toMatchObject({ branchStock: 0, inventoryRecorded: true });
  });

  it("is per branch: stocking one branch does not mark another branch's product as recorded", async () => {
    await adjust(central.token, "add", 3);
    expect(await fromInventory(central.token)).toMatchObject({ inventoryRecorded: true });
    // The other admin's branch has the product assigned but no row.
    expect(await fromInventory(other.token)).toMatchObject({ stock: 0, inventoryRecorded: false });
    expect(await fromProducts(other.token)).toMatchObject({ stock: 0, inventoryRecorded: false });
    expect(await fromByCashier(other.token)).toMatchObject({ inventoryRecorded: false });
  });

  it("a rejected over-removal leaves no row behind (still not recorded)", async () => {
    const res = await adjust(central.token, "remove", 1);
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe("INSUFFICIENT_STOCK");
    expect(await fromInventory(central.token)).toMatchObject({ inventoryRecorded: false });
  });
});
