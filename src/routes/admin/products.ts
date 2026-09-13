import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminProduct, paginate, UNIT_MAP_REVERSE } from "../../lib/serializeAdmin.js";
import { toDecimal, round2 } from "../../lib/money.js";
import { adjustStock } from "../../services/inventoryService.js";
import { assertCashierBelongsToShop } from "../../lib/cashierAccess.js";

const querySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const unitEnum = z.enum(["kg", "g", "litre", "ml", "piece", "tray", "box"]);

// Cashier-level inventory foundation: an initial `stock` on a brand-new
// product must have an owner — cashierId is required whenever stock > 0
// (validated below, not in the schema itself, since 0 initial stock has
// nobody to assign yet and that's fine).
const productSchema = z.object({
  name: z.string().trim().min(1),
  category: z.string().trim().min(1),
  sellingPrice: z.coerce.number().nonnegative(),
  costPrice: z.coerce.number().nonnegative().optional(),
  stock: z.coerce.number().int().min(0),
  cashierId: z.string().trim().min(1).optional(),
  unit: unitEnum,
  lowStockThreshold: z.coerce.number().int().min(0),
  status: z.enum(["active", "inactive"]).default("active"),
  sku: z.string().trim().optional(),
  barcode: z.string().trim().optional(),
});

// Editing a product's catalog details (name/price/category/etc.) never
// touches stock directly anymore — stock is cashier-owned, so it only
// ever moves through adjustStock (via /:id/adjust-stock below or
// /api/admin/inventory/adjustments), which always records a cashier owner
// and an InventoryMovement. Accepting a bare `stock` number here with no
// cashier attached would silently bypass both.
const productEditSchema = productSchema.omit({ stock: true, cashierId: true });

const adjustSchema = z.object({
  delta: z.coerce.number().int(),
  // Cashier-level inventory foundation: every adjustment targets a
  // specific cashier's own inventory — never a shop-wide pool.
  cashierId: z.string().trim().min(1, "Select which cashier this adjustment applies to."),
});

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

    // Any non-zero initial stock needs an owning cashier — never trust the
    // selected cashierId at face value.
    if (body.stock > 0) {
      if (!body.cashierId) {
        throw Errors.validation("Select which cashier should receive the initial stock.");
      }
      await assertCashierBelongsToShop(admin.shopId!, body.cashierId);
    }

    const product = await prisma.$transaction(async (tx) => {
      // Created with stock 0 — any initial stock is applied right after,
      // through adjustStock, so it lands in a real CashierInventory row
      // (with a matching InventoryMovement) instead of bypassing both.
      const created = await tx.product.create({
        data: {
          shopId: admin.shopId!,
          name: body.name,
          category: body.category,
          sellingPrice: round2(toDecimal(body.sellingPrice)),
          costPrice: body.costPrice != null ? round2(toDecimal(body.costPrice)) : null,
          stock: 0,
          unit: UNIT_MAP_REVERSE[body.unit] as never,
          lowStockThreshold: body.lowStockThreshold,
          status: body.status === "active" ? "ACTIVE" : "INACTIVE",
          sku: body.sku,
          barcode: body.barcode,
        },
      });

      if (body.stock > 0) {
        await adjustStock(tx, {
          shopId: admin.shopId!,
          cashierId: body.cashierId!,
          productId: created.id,
          delta: body.stock,
          type: "ADJUSTMENT",
          reason: "Initial stock on product creation",
          actorId: admin.id,
        });
        return tx.product.findUniqueOrThrow({ where: { id: created.id } });
      }
      return created;
    });

    await recordAudit({
      action: "PRODUCT_CREATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Product",
      entityId: product.id,
      ...(body.stock > 0 ? { metadata: { initialStock: body.stock, cashierId: body.cashierId } } : {}),
    });

    return reply.code(201).send(toAdminProduct(product));
  });

  // ── PUT /api/admin/products/:id ─────────────────────────────────────
  fastify.put<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    // Stock is intentionally NOT part of this schema — see
    // productEditSchema's doc comment. Use /:id/adjust-stock or
    // /api/admin/inventory/adjustments (both cashier-scoped) instead.
    const body = parseBody(productEditSchema, request.body);

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
    // Never trust the admin-selected cashierId at face value.
    await assertCashierBelongsToShop(admin.shopId!, body.cashierId);

    const updated = await prisma.$transaction(async (tx) => {
      await adjustStock(tx, {
        shopId: admin.shopId!,
        cashierId: body.cashierId,
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
      metadata: { delta: body.delta, cashierId: body.cashierId },
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
