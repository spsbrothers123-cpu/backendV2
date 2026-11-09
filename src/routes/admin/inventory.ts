import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminProduct, toStockMovement, paginate, productStatusLabel } from "../../lib/serializeAdmin.js";
import { toNumber } from "../../lib/money.js";
import { assignedToShop, getAssignedProductOrThrow } from "../../lib/branchCatalog.js";
import { resolveStockCashier } from "../../lib/stockActor.js";
import { adjustStock, getInventoryMode, getRecordedProductIds, getShopStockMap, withBranchStock } from "../../services/inventoryService.js";
import { centralAdminOnly } from "../../lib/centralAdmin.js";

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
  // Cashier-level inventory foundation: every manual adjustment targets a
  // specific cashier's own inventory — never a shop-wide pool.
  // Required before the BranchInventory cutover, optional actor metadata after it.
  cashierId: z.string().trim().min(1).optional(),
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
    const items = await withBranchStock(
      prisma,
      admin.shopId!,
      await prisma.product.findMany({ where: { ...assignedToShop(admin.shopId!), status: "ACTIVE" } })
    );
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
      ...assignedToShop(admin.shopId!),
      status: "ACTIVE" as const,
      ...(q.category && q.category !== "all" ? { category: q.category } : {}),
      ...(q.search
        ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { category: { contains: q.search, mode: "insensitive" as const } }] }
        : {}),
    };

    const all = await withBranchStock(prisma, admin.shopId!, await prisma.product.findMany({ where, orderBy: { name: "asc" } }));
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
    // Stage 3.3 (additive): true when a BranchInventory row exists, even at 0.
    const recorded = await getRecordedProductIds(prisma, admin.shopId!, page.map((p) => p.id));
    return paginate(
      page.map((p) => ({ ...toAdminProduct(p), inventoryRecorded: recorded.has(p.id) })),
      filtered.length,
      q.page,
      q.pageSize
    );
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
  fastify.post("/adjustments", { preHandler: centralAdminOnly("adjust stock") }, async (request) => {
    const admin = request.authUser!;
    const body = parseBody(adjustmentSchema, request.body);

    const product = await getAssignedProductOrThrow(prisma, body.productId, admin.shopId!);
    // Never trust the admin-selected cashierId at face value.
    const stockCashierId = await resolveStockCashier(admin.shopId!, body.cashierId);

    const delta = body.adjustmentType === "add" ? body.quantity : -body.quantity;

    const updated = await prisma.$transaction(async (tx) => {
      await adjustStock(tx, {
        shopId: admin.shopId!,
        cashierId: stockCashierId,
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
      metadata: { delta, reason: body.reason, cashierId: body.cashierId },
    });

    const [shown] = await withBranchStock(prisma, admin.shopId!, [updated]);
    return toAdminProduct(shown);
  });

  // ── GET /api/admin/inventory/:productId/by-cashier ────────────────────
  // Per-cashier breakdown for one product — e.g. "Arun: 50, Bala: 100".
  // Never merges these into a single number; each row is that cashier's
  // own, isolated stock. Also what an Admin UI would use to populate the
  // "which cashier?" selector for /adjustments and purchases.
  fastify.get<{ Params: { productId: string } }>("/:productId/by-cashier", async (request) => {
    const admin = request.authUser!;
    const product = await getAssignedProductOrThrow(prisma, request.params.productId, admin.shopId!);

    const branchStock = (await getShopStockMap(prisma, admin.shopId!, [product.id])).get(product.id) ?? 0;
    // Stage 3.3 (additive): distinguishes "no BranchInventory row" from a genuine 0.
    const inventoryRecorded = (await getRecordedProductIds(prisma, admin.shopId!, [product.id])).has(product.id);

    // After the BranchInventory cutover stock is NOT cashier-owned: there is
    // one quantity per branch and no per-cashier split to report.
    if ((await getInventoryMode(prisma)) === "BRANCH") {
      return {
        productId: product.id,
        productName: product.name,
        totalStock: branchStock,
        branchStock,
        inventoryRecorded,
        byCashier: [] as { cashierId: string; cashierName: string; quantity: number }[],
      };
    }

    const [rows, cashiers] = await Promise.all([
      prisma.cashierInventory.findMany({
        where: { shopId: admin.shopId!, productId: product.id },
        include: { cashier: { select: { id: true, name: true } } },
      }),
      prisma.user.findMany({
        where: { shopId: admin.shopId!, role: "CASHIER", status: "ACTIVE" },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
    ]);

    const quantityByCashierId = new Map(rows.map((r) => [r.cashierId, r.quantity]));
    return {
      productId: product.id,
      productName: product.name,
      // This BRANCH's total — not the all-branch Product.stock aggregate.
      totalStock: branchStock,
      branchStock,
      inventoryRecorded,
      byCashier: cashiers.map((c) => ({
        cashierId: c.id,
        cashierName: c.name,
        quantity: quantityByCashierId.get(c.id) ?? 0,
      })),
    };
  });

  // ── GET /api/admin/inventory/alerts ───────────────────────────────────
  fastify.get("/alerts", async (request) => {
    const admin = request.authUser!;
    const items = await withBranchStock(
      prisma,
      admin.shopId!,
      await prisma.product.findMany({ where: { ...assignedToShop(admin.shopId!), status: "ACTIVE" } })
    );
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
