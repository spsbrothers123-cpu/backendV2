/**
 * Stage 3.4 — GET /api/admin/products?shopId=… against a REAL database.
 * Runs ONLY against a disposable local Postgres whose name contains "test"
 * (enforced by test/setup.ts):
 *
 *   RUN_INTEGRATION_TESTS=1 npx vitest run test/adminProductsShopId.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { assignProductToAllBranches, setBranchAssignment } from "../src/lib/branchCatalog.js";
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

const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
const json = (r: { payload: string }) => JSON.parse(r.payload);

let central: Awaited<ReturnType<typeof createAdminFixture>>;
let other: Awaited<ReturnType<typeof createAdminFixture>>;
let assignedEverywhere: string;
let hiddenAtOther: string;

beforeEach(async () => {
  if (!enabled) return;
  await resetDb();
  await prisma.systemFlag.upsert({ where: { key: "inventory_source" }, update: { value: "BRANCH" }, create: { key: "inventory_source", value: "BRANCH" } });
  central = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
  envMut.CENTRAL_ADMIN_USER_ID = central.user.id;
  other = await createAdminFixture(app, { email: "other@rbr.test", shopLocation: "Palladam" });
  const mk = (name: string) =>
    prisma.product.create({ data: { shopId: central.shop.id, name, category: "Eggs", sellingPrice: 100, stock: 0, unit: "TRAY", lowStockThreshold: 1 } });
  const a = await mk("Everywhere");
  const b = await mk("Hidden at Palladam");
  await assignProductToAllBranches(prisma, a.id, null);
  await assignProductToAllBranches(prisma, b.id, null);
  await prisma.$transaction((tx) => setBranchAssignment(tx, { shopId: other.shop.id, productId: b.id, assigned: false, actorId: central.user.id }));
  assignedEverywhere = a.id;
  hiddenAtOther = b.id;
});

describe.skipIf(!enabled)("Stage 3.4 — GET /admin/products?shopId", () => {
  it("omitted shopId is unchanged (selector branch)", async () => {
    const ids = json(await get("/api/admin/products?pageSize=50", central.token)).items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining([assignedEverywhere, hiddenAtOther]));
  });

  it("Central Admin sees ANOTHER branch's catalog, with that branch's assignment state", async () => {
    const res = await get(`/api/admin/products?shopId=${other.shop.id}&pageSize=50`, central.token);
    expect(res.statusCode).toBe(200);
    const ids = json(res).items.map((i: { id: string }) => i.id);
    expect(ids).toContain(assignedEverywhere);
    expect(ids).not.toContain(hiddenAtOther); // unassigned there: not offered for receiving
  });

  it("refuses a non-central admin, and an unknown branch", async () => {
    expect((await get(`/api/admin/products?shopId=${central.shop.id}`, other.token)).statusCode).toBe(403);
    const unknown = await get("/api/admin/products?shopId=does-not-exist", central.token);
    expect(unknown.statusCode).toBe(404);
    expect(json(unknown).code).toBe("SHOP_NOT_FOUND");
  });
});
