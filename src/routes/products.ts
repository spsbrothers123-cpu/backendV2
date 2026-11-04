import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { toCashierProduct } from "../lib/serializeCashier.js";
import { getCashierStockMap } from "../services/inventoryService.js";
import { assignedToShop } from "../lib/branchCatalog.js";
import { getEffectivePrices } from "../lib/pricing.js";

export default async function productsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("CASHIER"));

  // ── GET /api/products?query=&category=&barcode= ──────────────────────
  fastify.get<{ Querystring: { query?: string; category?: string; barcode?: string } }>("/", async (request) => {
    const shopId = request.authUser!.shopId!;
    // Cashier-level inventory foundation: stock shown here is always THIS
    // authenticated cashier's own — never the shop-wide Product.stock
    // aggregate. cashierId comes from the JWT, never the request.
    const cashierId = request.authUser!.id;
    const { query, category, barcode } = request.query;

    if (barcode) {
      const products = await prisma.product.findMany({
        where: { ...assignedToShop(shopId), status: "ACTIVE", barcode },
      });
      const stockMap = await getCashierStockMap(prisma, shopId, cashierId, products.map((p) => p.id));
      const prices = await getEffectivePrices(prisma, shopId, products);
      return products.map((p) => toCashierProduct(p, stockMap.get(p.id) ?? 0, prices.get(p.id)));
    }

    const products = await prisma.product.findMany({
      where: {
        // Stage 2.2: visibility comes from BranchProduct (assigned to THIS
        // cashier's branch), never from Product.shopId (legacy origin).
        ...assignedToShop(shopId),
        status: "ACTIVE",
        ...(category && category !== "All" ? { category } : {}),
        ...(query
          ? {
              OR: [
                { name: { contains: query, mode: "insensitive" } },
                { sku: { contains: query, mode: "insensitive" } },
                { barcode: { contains: query, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { name: "asc" },
    });
    const stockMap = await getCashierStockMap(prisma, shopId, cashierId, products.map((p) => p.id));
    const prices = await getEffectivePrices(prisma, shopId, products);
    return products.map((p) => toCashierProduct(p, stockMap.get(p.id) ?? 0, prices.get(p.id)));
  });

  // ── GET /api/products/categories ──────────────────────────────────────
  fastify.get("/categories", async (request) => {
    const shopId = request.authUser!.shopId!;
    const rows = await prisma.product.findMany({
      where: { ...assignedToShop(shopId), status: "ACTIVE" },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    });
    return rows.map((r) => r.category);
  });
}
