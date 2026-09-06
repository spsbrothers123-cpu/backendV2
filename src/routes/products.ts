import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { toCashierProduct } from "../lib/serializeCashier.js";

export default async function productsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("CASHIER"));

  // ── GET /api/products?query=&category=&barcode= ──────────────────────
  fastify.get<{ Querystring: { query?: string; category?: string; barcode?: string } }>("/", async (request) => {
    const shopId = request.authUser!.shopId!;
    const { query, category, barcode } = request.query;

    if (barcode) {
      const products = await prisma.product.findMany({
        where: { shopId, status: "ACTIVE", barcode },
      });
      return products.map(toCashierProduct);
    }

    const products = await prisma.product.findMany({
      where: {
        shopId,
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
    return products.map(toCashierProduct);
  });

  // ── GET /api/products/categories ──────────────────────────────────────
  fastify.get("/categories", async (request) => {
    const shopId = request.authUser!.shopId!;
    const rows = await prisma.product.findMany({
      where: { shopId, status: "ACTIVE" },
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    });
    return rows.map((r) => r.category);
  });
}
