import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminProduct, toStockMovement, paginate, productStatusLabel } from "../../lib/serializeAdmin.js";
import { toNumber } from "../../lib/money.js";
import { adjustStock } from "../../services/inventoryService.js";

const overviewQuerySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const movementsQuerySchema = z.object({
  search: z.string().optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const adjustmentSchema = z.object({
  productId: z.string(),
  adjustmentType: z.enum(["add", "remove"]),
  quantity: z.coerce.number().positive(),
  reason: z.string().trim().min(1),
  notes: z.string().trim().optional(),
});

export default async function adminInventoryRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/inventory/kpis ─────────────────────────────────────
  fastify.get("/kpis", async (request) => {
    const admin = request.authUser!;
    const items = await prisma.product.findMany({ where: { shopId: admin.shopId!, status: "ACTIVE" } });
    const kpis = {
      totalItems: items.length,
      lowStock: items.filter((p) => productStatusLabel(p) === "Low Stock").length,
      outOfStock: items.filter((p) => productStatusLabel(p) === "Out of Stock").length,
      stockValue: items.reduce((sum, p) => sum + p.stock * toNumber(p.costPrice ?? p.sellingPrice), 0),
    };
    return kpis;
  });

  // ── GET /api/admin/inventory ───────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = overviewQuerySchema.parse(request.query);

    const where = {
      shopId: admin.shopId!,
      status: "ACTIVE" as const,
      ...(q.category && q.category !== "all" ? { category: q.category } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { category: { contains: q.search, mode: "insensitive" as const } }] }
        : {}),
    };

    const all = await prisma.product.findMany({ where, orderBy: { name: "asc" } });
    const filtered =
      q.status && q.status !== "all"
        ? all.filter((p) => {
            const label = productStatusLabel(p);
            return (
              (q.status === "in_stock" && label === "In Stock") ||
              (q.status === "low_stock" && label === "Low Stock") ||
              (q.status === "out_of_stock" && label === "Out of Stock")
            );
          })
        : all;

    const start = (q.page - 1) * q.pageSize;
    const page = filtered.slice(start, start + q.pageSize);
    return paginate(page.map(toAdminProduct), filtered.length, q.page, q.pageSize);
  });

  // ── GET /api/admin/inventory/movements ────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/movements", async (request) => {
    const admin = request.authUser!;
    const q = movementsQuerySchema.parse(request.query);

    const where = {
      shopId: admin.shopId!,
      ...(q.type && q.type !== "all" ? { type: q.type as never } : {}),
      ...(q.search ? { reason: { contains: q.search, mode: "insensitive" as const } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.inventoryMovement.findMany({
        where,
        include: { product: true, actor: true },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.inventoryMovement.count({ where }),
    ]);

    return paginate(items.map(toStockMovement), total, q.page, q.pageSize);
  });

  // ── POST /api/admin/inventory/adjustments ─────────────────────────────
  fastify.post("/adjustments", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(adjustmentSchema, request.body);

    const product = await prisma.product.findUnique({ where: { id: body.productId } });
    if (!product || product.shopId !== admin.shopId) {
      throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
    }

    const delta = body.adjustmentType === "add" ? body.quantity : -body.quantity;

    const updated = await prisma.$transaction(async (tx) => {
      await adjustStock(tx, {
        shopId: admin.shopId!,
        productId: product.id,
        delta,
        type: "ADJUSTMENT",
        reason: body.notes ? `${body.reason} — ${body.notes}` : body.reason,
        actorId: admin.id,
      });
      return tx.product.findUniqueOrThrow({ where: { id: product.id } });
    });

    await recordAudit({
      action: "INVENTORY_ADJUSTED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Product",
      entityId: product.id,
      metadata: { delta, reason: body.reason },
    });

    return toAdminProduct(updated);
  });

  // ── GET /api/admin/inventory/alerts ───────────────────────────────────
  fastify.get("/alerts", async (request) => {
    const admin = request.authUser!;
    const items = await prisma.product.findMany({ where: { shopId: admin.shopId!, status: "ACTIVE" } });
    return items
      .filter((p) => productStatusLabel(p) !== "In Stock")
      .map((p) => ({
        productId: p.id,
        productName: p.name,
        currentStock: p.stock,
        unit: p.unit.toLowerCase(),
        threshold: p.lowStockThreshold,
        status: p.stock <= 0 ? "Critical" : "Low Stock",
      }));
  });
}
