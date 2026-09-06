import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminProduct, paginate, UNIT_MAP_REVERSE } from "../../lib/serializeAdmin.js";
import { toDecimal, round2 } from "../../lib/money.js";
import { adjustStock } from "../../services/inventoryService.js";

const querySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const unitEnum = z.enum(["kg", "g", "litre", "ml", "piece", "tray", "box"]);

const productSchema = z.object({
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  sellingPrice: z.coerce.number().nonnegative(),
  costPrice: z.coerce.number().nonnegative().optional(),
  stock: z.coerce.number().int().min(0),
  unit: unitEnum,
  lowStockThreshold: z.coerce.number().int().min(0),
  status: z.enum(["active", "inactive"]).default("active"),
  sku: z.string().trim().optional(),
  barcode: z.string().trim().optional(),
});

const adjustSchema = z.object({ delta: z.coerce.number().int() });

export default async function adminProductsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/products ────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = querySchema.parse(request.query);

    const where = {
      shopId: admin.shopId!,
      ...(q.category && q.category !== "all" ? { category: q.category } : {}),
      ...(q.status && q.status !== "all" ? { status: q.status === "active" ? ("ACTIVE" as const) : ("INACTIVE" as const) } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { category: { contains: q.search, mode: "insensitive" as const } }] }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    return paginate(items.map(toAdminProduct), total, q.page, q.pageSize);
  });

  // ── POST /api/admin/products ───────────────────────────────────────
  fastify.post("/", async (request, reply) => {
    const admin = request.authUser!;
    const body = parseBody(productSchema, request.body);

    const product = await prisma.product.create({
      data: {
        shopId: admin.shopId!,
        name: body.name,
        category: body.category,
        sellingPrice: round2(toDecimal(body.sellingPrice)),
        costPrice: body.costPrice != null ? round2(toDecimal(body.costPrice)) : null,
        stock: body.stock,
        unit: UNIT_MAP_REVERSE[body.unit] as never,
        lowStockThreshold: body.lowStockThreshold,
        status: body.status === "active" ? "ACTIVE" : "INACTIVE",
        sku: body.sku,
        barcode: body.barcode,
      },
    });

    await recordAudit({
      action: "PRODUCT_CREATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Product",
      entityId: product.id,
    });

    return reply.code(201).send(toAdminProduct(product));
  });

  // ── PUT /api/admin/products/:id ─────────────────────────────────────
  fastify.put<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(productSchema, request.body);

    const existing = await prisma.product.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
    }

    const updated = await prisma.product.update({
      where: { id: existing.id },
      data: {
        name: body.name,
        category: body.category,
        sellingPrice: round2(toDecimal(body.sellingPrice)),
        costPrice: body.costPrice != null ? round2(toDecimal(body.costPrice)) : null,
        stock: body.stock,
        unit: UNIT_MAP_REVERSE[body.unit] as never,
        lowStockThreshold: body.lowStockThreshold,
        status: body.status === "active" ? "ACTIVE" : "INACTIVE",
        sku: body.sku,
        barcode: body.barcode,
      },
    });

    await recordAudit({
      action: "PRODUCT_UPDATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Product",
      entityId: updated.id,
    });

    return toAdminProduct(updated);
  });

  // ── PATCH /api/admin/products/:id/adjust-stock ───────────────────────
  fastify.patch<{ Params: { id: string } }>("/:id/adjust-stock", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(adjustSchema, request.body);

    const existing = await prisma.product.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
    }

    const updated = await prisma.$transaction(async (tx) => {
      await adjustStock(tx, {
        shopId: admin.shopId!,
        productId: existing.id,
        delta: body.delta,
        type: "ADJUSTMENT",
        reason: "Manual stock adjustment",
        actorId: admin.id,
      });
      return tx.product.findUniqueOrThrow({ where: { id: existing.id } });
    });

    await recordAudit({
      action: "INVENTORY_ADJUSTED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Product",
      entityId: existing.id,
      metadata: { delta: body.delta },
    });

    return toAdminProduct(updated);
  });

  // ── DELETE /api/admin/products/:id — soft delete ─────────────────────
  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const admin = request.authUser!;
    const existing = await prisma.product.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
    }
    await prisma.product.update({ where: { id: existing.id }, data: { status: "INACTIVE" } });
    await recordAudit({
      action: "PRODUCT_DELETED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Product",
      entityId: existing.id,
    });
    return reply.code(204).send();
  });
}
