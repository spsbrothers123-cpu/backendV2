import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";

const RESULTS_PER_GROUP = 5;

export default async function adminSearchRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/search?q= ─────────────────────────────────────────
  fastify.get<{ Querystring: { q?: string } }>("/", async (request) => {
    const admin = request.authUser!;
    const q = (request.query.q ?? "").trim();
    if (!q) return { products: [], customers: [], transactions: [] };

    const [products, customers, bills] = await Promise.all([
      prisma.product.findMany({
        where: { shopId: admin.shopId!, name: { contains: q, mode: "insensitive" } },
        take: RESULTS_PER_GROUP,
        orderBy: { name: "asc" },
      }),
      prisma.customer.findMany({
        where: {
          shopId: admin.shopId!,
          OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }],
        },
        take: RESULTS_PER_GROUP,
        orderBy: { name: "asc" },
      }),
      prisma.bill.findMany({
        where: {
          shopId: admin.shopId!,
          status: "PAID",
          OR: [
            { billNumber: { contains: q, mode: "insensitive" } },
            { customer: { name: { contains: q, mode: "insensitive" } } },
          ],
        },
        take: RESULTS_PER_GROUP,
        orderBy: { paidAt: "desc" },
        include: { customer: true },
      }),
    ]);

    return {
      products: products.map((p) => ({ id: p.id, label: p.name, subtitle: p.category, path: "/admin/products" })),
      customers: customers.map((c) => ({ id: c.id, label: c.name, subtitle: c.phone, path: "/admin/customers" })),
      transactions: bills.map((b) => ({
        id: b.id,
        label: b.billNumber ?? b.id,
        subtitle: b.customer?.name ?? "Walk-in customer",
        path: "/admin/history",
      })),
    };
  });
}
