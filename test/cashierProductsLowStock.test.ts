/**
 * Stage 4.4 — GET /api/products now includes each product's lowStockThreshold.
 *
 * Route-level test with Prisma and the stock/pricing services mocked, so it
 * needs NO database. Proves the change is purely additive: every pre-existing
 * field keeps its value, the threshold comes from the product row, branch
 * scoping and stock/price resolution are untouched, and historical snapshots
 * (bill / held-bill lines) do not gain the field.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Decimal } from "@prisma/client/runtime/library.js";

const m = vi.hoisted(() => ({
  productFindMany: vi.fn(),
  getCashierStockMap: vi.fn(),
  getEffectivePrices: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: { product: { findMany: m.productFindMany } } }));
vi.mock("../src/services/inventoryService.js", () => ({ getCashierStockMap: m.getCashierStockMap }));
vi.mock("../src/lib/pricing.js", () => ({ getEffectivePrices: m.getEffectivePrices }));

import productsRoutes from "../src/routes/products.js";
import { toCashierProduct } from "../src/lib/serializeCashier.js";

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: `P-${id}`, category: "Eggs", sku: `SKU-${id}`, barcode: `890${id}`,
  sellingPrice: new Decimal("100"), costPrice: null, stock: 999, unit: "TRAY",
  lowStockThreshold: 10, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date(), shopId: "legacy", ...over,
});

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("requireRole", () => async () => {});
  app.addHook("onRequest", async (request) => {
    (request as unknown as { authUser: unknown }).authUser = { id: "cashier-1", role: "CASHIER", shopId: "shop-A" };
  });
  await app.register(productsRoutes, { prefix: "/api/products" });
  await app.ready();
  return app;
}

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  m.productFindMany.mockResolvedValue([
    row("1", { lowStockThreshold: 10 }),
    row("2", { lowStockThreshold: 0 }),
    row("3", { lowStockThreshold: 3 }),
  ]);
  m.getCashierStockMap.mockResolvedValue(new Map([["1", 8], ["2", 0]])); // "3" has no row => 0
  m.getEffectivePrices.mockResolvedValue(new Map([["1", new Decimal("120.50")]]));
  app = await build();
});

describe("GET /api/products — lowStockThreshold (Stage 4.4, additive)", () => {
  it("returns each product's own lowStockThreshold, including 0", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.map((p: { id: string; lowStockThreshold: number }) => [p.id, p.lowStockThreshold])).toEqual([["1", 10], ["2", 0], ["3", 3]]);
  });

  it("keeps every pre-existing field and value unchanged (stock is branch stock, price is effective price)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/products" });
    const [first, second, third] = JSON.parse(res.payload);
    expect(first).toEqual({
      id: "1", name: "P-1", sku: "SKU-1", barcode: "8901", category: "Eggs",
      price: 120.5, unit: "tray", stock: 8, lowStockThreshold: 10,
    });
    expect(second).toMatchObject({ stock: 0, price: 100 }); // zero-stock assigned product stays listed
    expect(third).toMatchObject({ stock: 0 }); // missing inventory row => 0, not Product.stock (999)
    // Nothing but the one new key was added.
    expect(Object.keys(first).sort()).toEqual(["barcode", "category", "id", "lowStockThreshold", "name", "price", "sku", "stock", "unit"]);
  });

  it("does not change scoping: authenticated branch + cashier, never request input", async () => {
    await app.inject({ method: "GET", url: "/api/products?query=egg&shopId=shop-B&cashierId=other" });
    expect(m.getCashierStockMap.mock.calls[0].slice(1, 3)).toEqual(["shop-A", "cashier-1"]);
    expect(JSON.stringify(m.productFindMany.mock.calls[0][0])).not.toContain("shop-B");
  });

  it("barcode lookup also carries the threshold", async () => {
    m.productFindMany.mockResolvedValue([row("1", { lowStockThreshold: 4 })]);
    const res = await app.inject({ method: "GET", url: "/api/products?barcode=8901" });
    expect(JSON.parse(res.payload)[0]).toMatchObject({ id: "1", lowStockThreshold: 4 });
  });
});

describe("toCashierProduct — snapshots stay unchanged", () => {
  it("omits lowStockThreshold when no live stock is supplied (bill / held-bill lines)", () => {
    const out = toCashierProduct(row("1") as never);
    expect(out).not.toHaveProperty("lowStockThreshold");
    expect(out.stock).toBe(999);
  });
  it("includes it when live stock is supplied, even if that stock is 0", () => {
    expect(toCashierProduct(row("1", { lowStockThreshold: 7 }) as never, 0)).toMatchObject({ stock: 0, lowStockThreshold: 7 });
  });
});
