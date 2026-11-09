/**
 * Stage 3.4 — GET /api/admin/products?shopId=… (optional branch override).
 *
 * Route-level test with Prisma and the stock service mocked, so it needs NO
 * database (runs in the default `npx vitest run`). The real-database variant
 * is test/adminProductsShopId.integration.test.ts.
 *
 * Proves: omitted shopId keeps the pre-3.4 behaviour (selector branch);
 * shopId is Central Admin only; the branch id is validated; and when it is
 * accepted EVERY branch-scoped query (assignment filter, assignment state,
 * stock, inventoryRecorded) uses that branch, never the selector's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";

const m = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  productCount: vi.fn(),
  branchProductFindMany: vi.fn(),
  shopFindUnique: vi.fn(),
  withBranchStock: vi.fn(),
  getRecordedProductIds: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    product: { findMany: m.productFindMany, count: m.productCount },
    branchProduct: { findMany: m.branchProductFindMany },
    shop: { findUnique: m.shopFindUnique },
  },
}));
vi.mock("../src/services/inventoryService.js", () => ({
  adjustStock: vi.fn(),
  withBranchStock: m.withBranchStock,
  getRecordedProductIds: m.getRecordedProductIds,
}));

import adminProductsRoutes from "../src/routes/admin/products.js";
import { AppError } from "../src/lib/errors.js";
import { env } from "../src/config/env.js";

const envMut = env as unknown as { CENTRAL_ADMIN_USER_ID?: string };
const CENTRAL = { id: "u-central", role: "ADMIN", status: "ACTIVE", shopId: "shop-selected" };
const OTHER_ADMIN = { id: "u-other", role: "ADMIN", status: "ACTIVE", shopId: "shop-other" };

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("requireRole", () => async () => {});
  app.addHook("onRequest", async (request) => {
    (request as unknown as { authUser: unknown }).authUser = JSON.parse(String(request.headers["x-test-user"]));
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ code: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(422).send({ code: "VALIDATION_ERROR" });
    return reply.code(500).send({ code: "INTERNAL", message: String(err) });
  });
  await app.register(adminProductsRoutes, { prefix: "/api/admin/products" });
  await app.ready();
  return app;
}

const product = (id: string) => ({
  id, name: `P-${id}`, category: "Eggs", sellingPrice: new Prisma.Decimal(100), costPrice: null, stock: 0, unit: "TRAY",
  lowStockThreshold: 1, status: "ACTIVE", sku: null, barcode: null, createdAt: new Date(), updatedAt: new Date(),
});
const get = (app: FastifyInstance, user: unknown, qs = "") =>
  app.inject({ method: "GET", url: `/api/admin/products${qs}`, headers: { "x-test-user": JSON.stringify(user) } });

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  envMut.CENTRAL_ADMIN_USER_ID = CENTRAL.id;
  m.productFindMany.mockResolvedValue([product("p1")]);
  m.productCount.mockResolvedValue(1);
  m.branchProductFindMany.mockResolvedValue([{ productId: "p1", isAssigned: true, priceOverride: null }]);
  m.shopFindUnique.mockResolvedValue({ id: "shop-receiving" });
  m.withBranchStock.mockImplementation(async (_db: unknown, _shopId: string, items: unknown[]) => items);
  m.getRecordedProductIds.mockResolvedValue(new Set(["p1"]));
  app = await build();
});

describe("GET /api/admin/products — optional shopId (Stage 3.4)", () => {
  it("without shopId behaves as before: the selector's branch, no shop lookup, no central-admin requirement", async () => {
    const res = await get(app, OTHER_ADMIN);
    expect(res.statusCode).toBe(200);
    expect(m.shopFindUnique).not.toHaveBeenCalled();
    expect(m.withBranchStock.mock.calls[0][1]).toBe("shop-other");
    expect(m.getRecordedProductIds.mock.calls[0][1]).toBe("shop-other");
    expect(m.branchProductFindMany.mock.calls[0][0].where.shopId).toBe("shop-other");
    expect(m.productFindMany.mock.calls[0][0].where.branchProducts.some).toEqual({ shopId: "shop-other", isAssigned: true });
  });

  it("with shopId, the Central Admin gets THAT branch's data — every scoped query uses it, not the selector", async () => {
    const res = await get(app, CENTRAL, "?shopId=shop-receiving&assignment=assigned");
    expect(res.statusCode).toBe(200);
    expect(m.productFindMany.mock.calls[0][0].where.branchProducts.some).toEqual({ shopId: "shop-receiving", isAssigned: true });
    expect(m.branchProductFindMany.mock.calls[0][0].where.shopId).toBe("shop-receiving");
    expect(m.withBranchStock.mock.calls[0][1]).toBe("shop-receiving");
    expect(m.getRecordedProductIds.mock.calls[0][1]).toBe("shop-receiving");
    expect(JSON.stringify(m.productFindMany.mock.calls[0][0])).not.toContain("shop-selected");
    const body = JSON.parse(res.payload);
    expect(body.items[0]).toMatchObject({ id: "p1", assigned: true, inventoryRecorded: true });
  });

  it("refuses shopId for a non-central admin (403) and does not even look the branch up", async () => {
    const res = await get(app, OTHER_ADMIN, "?shopId=shop-receiving");
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.payload).code).toBe("CENTRAL_ADMIN_REQUIRED");
    expect(m.shopFindUnique).not.toHaveBeenCalled();
    expect(m.productFindMany).not.toHaveBeenCalled();
  });

  it("fails closed (503) when no Central Admin is configured", async () => {
    envMut.CENTRAL_ADMIN_USER_ID = undefined;
    const res = await get(app, CENTRAL, "?shopId=shop-receiving");
    expect(res.statusCode).toBe(503);
    expect(m.productFindMany).not.toHaveBeenCalled();
  });

  it("validates the branch id: unknown -> 404 SHOP_NOT_FOUND, blank -> 422; nothing is queried", async () => {
    m.shopFindUnique.mockResolvedValue(null);
    const unknown = await get(app, CENTRAL, "?shopId=nope");
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.payload).code).toBe("SHOP_NOT_FOUND");
    const blank = await get(app, CENTRAL, "?shopId=");
    expect(blank.statusCode).toBe(422);
    expect(m.productFindMany).not.toHaveBeenCalled();
  });
});
