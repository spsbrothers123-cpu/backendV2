import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminProduct, paginate, UNIT_MAP_REVERSE } from "../../lib/serializeAdmin.js";
import { toDecimal, round2 } from "../../lib/money.js";
import { adjustStock, getRecordedProductIds, withBranchStock } from "../../services/inventoryService.js";
import { assignProductToAllBranches, getAssignedProductOrThrow, getProductInBranchCatalogOrThrow } from "../../lib/branchCatalog.js";
import { resolveStockCashier } from "../../lib/stockActor.js";
import { assertCentralAdminFor, centralAdminOnly } from "../../lib/centralAdmin.js";
import { effectivePrice } from "../../lib/pricing.js";
import { toNumber } from "../../lib/money.js";

const querySchema = z.object({
  search: z.string().optional(),
  category: z.string().optional(),
  status: z.string().optional(),
  // Stage 2.2: which branch assignment state to list for the selected branch.
  // Default "assigned" = what the branch actually carries; "unassigned" =
  // hidden-but-preserved products (so an admin can find them to re-assign).
  assignment: z.enum(["assigned", "unassigned", "all"]).default("assigned"),
  // Stage 3.4: OPTIONAL branch to list instead of the Global Shop Selector's
  // branch (used by the purchase form, whose receiving branch is chosen
  // explicitly). Central Admin only; omitted = unchanged behaviour.
  shopId: z.string().trim().min(1).optional(),
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
  // Required before the BranchInventory cutover (stock is cashier-owned),
  // optional actor metadata after it — enforced by resolveStockCashier.
  cashierId: z.string().trim().min(1).optional(),
});

export default async function adminProductsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/products ────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = querySchema.parse(request.query);

    // Stage 3.4: which branch's catalog to describe. Default (no shopId) is
    // exactly the pre-3.4 behaviour: the Global Shop Selector's branch. An
    // explicit shopId is Central Admin only and must name a real branch;
    // authorization runs BEFORE the lookup so a non-central admin cannot
    // probe which branch ids exist.
    let branchShopId = admin.shopId!;
    if (q.shopId !== undefined) {
      assertCentralAdminFor(admin, "view another branch's product catalog");
      const shop = await prisma.shop.findUnique({ where: { id: q.shopId }, select: { id: true } });
      if (!shop) throw Errors.notFound("Branch not found.", "SHOP_NOT_FOUND");
      branchShopId = shop.id;
    }

    // Visibility comes from BranchProduct, never Product.shopId (legacy origin).
    const assignmentFilter =
      q.assignment === "assigned"
        ? { branchProducts: { some: { shopId: branchShopId, isAssigned: true } } }
        : q.assignment === "unassigned"
          ? { branchProducts: { some: { shopId: branchShopId, isAssigned: false } } }
          : { branchProducts: { some: { shopId: branchShopId } } };

    const where = {
      ...assignmentFilter,
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

    // Report each product's assignment state for the selected branch.
    const stateRows = await prisma.branchProduct.findMany({
      where: { shopId: branchShopId, productId: { in: items.map((p) => p.id) } },
      select: { productId: true, isAssigned: true, priceOverride: true },
    });
    const assignedById = new Map(stateRows.map((r) => [r.productId, r.isAssigned]));
    const overrideById = new Map(stateRows.map((r) => [r.productId, r.priceOverride]));

    const branchItems = await withBranchStock(prisma, branchShopId, items);
    // Stage 3.3 (additive): true when a BranchInventory row exists, even at 0.
    const recorded = await getRecordedProductIds(prisma, branchShopId, items.map((p: { id: string }) => p.id));
    return paginate(
      branchItems.map((p) => {
        const override = overrideById.get(p.id) ?? null;
        return {
          ...toAdminProduct(p),
          assigned: assignedById.get(p.id) ?? false,
          inventoryRecorded: recorded.has(p.id),
          // Stage 2.5 (additive fields): sellingPrice above stays the COMMON
          // price; these two describe the selected branch.
          priceOverride: override != null ? toNumber(override) : null,
          effectivePrice: toNumber(effectivePrice(p.sellingPrice, override)),
        };
      }),
      total,
      q.page,
      q.pageSize
    );
  });

  // ── POST /api/admin/products ───────────────────────────────────────
  fastify.post("/", { preHandler: centralAdminOnly("add products to the catalog") }, async (request, reply) => {
    const admin = request.authUser!;
    const body = parseBody(productSchema, request.body);

    // Any non-zero initial stock needs an owning cashier — never trust the
    // selected cashierId at face value.
    const stockCashierId = body.stock > 0 ? await resolveStockCashier(admin.shopId!, body.cashierId) : null;

    const product = await prisma.$transaction(async (tx) => {
      // Created with stock 0 — any initial stock is applied right after,
      // through adjustStock, so it lands in a real CashierInventory row
      // (with a matching InventoryMovement) instead of bypassing both.
      const created = await tx.product.create({
        data: {
          // Legacy ORIGIN metadata only (which branch's admin created it).
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

      // Stage 2.2: a new product is assigned to EVERY existing branch, in the
      // same transaction as its creation (all-or-nothing). Assignment never
      // creates stock — each branch starts at zero except the initial stock
      // applied below to the selected cashier's branch.
      await assignProductToAllBranches(tx, created.id, admin.id);

      if (body.stock > 0) {
        await adjustStock(tx, {
          shopId: admin.shopId!,
          cashierId: stockCashierId,
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
    const [shown] = await withBranchStock(prisma, admin.shopId!, [product]);

    await recordAudit({
      action: "PRODUCT_CREATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Product",
      entityId: product.id,
      ...(body.stock > 0 ? { metadata: { initialStock: body.stock, cashierId: body.cashierId } } : {}),
    });

    return reply.code(201).send(toAdminProduct(shown));
  });

  // ── PUT /api/admin/products/:id ─────────────────────────────────────
  fastify.put<{ Params: { id: string } }>("/:id", { preHandler: centralAdminOnly("edit catalog products or prices") }, async (request) => {
    const admin = request.authUser!;
    // Stock is intentionally NOT part of this schema — see
    // productEditSchema's doc comment. Use /:id/adjust-stock or
    // /api/admin/inventory/adjustments (both cashier-scoped) instead.
    const body = parseBody(productEditSchema, request.body);

    const existing = await getProductInBranchCatalogOrThrow(prisma, request.params.id, admin.shopId!);

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

    const [shown] = await withBranchStock(prisma, admin.shopId!, [updated]);
    return toAdminProduct(shown);
  });

  // ── PATCH /api/admin/products/:id/adjust-stock ───────────────────────
  fastify.patch<{ Params: { id: string } }>("/:id/adjust-stock", { preHandler: centralAdminOnly("adjust stock") }, async (request) => {
    const admin = request.authUser!;
    const body = parseBody(adjustSchema, request.body);

    // Stock can only move for a product ASSIGNED to this branch.
    const existing = await getAssignedProductOrThrow(prisma, request.params.id, admin.shopId!);
    // Never trust the admin-selected cashierId at face value.
    const stockCashierId = await resolveStockCashier(admin.shopId!, body.cashierId);

    const updated = await prisma.$transaction(async (tx) => {
      await adjustStock(tx, {
        shopId: admin.shopId!,
        cashierId: stockCashierId,
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

    const [shown] = await withBranchStock(prisma, admin.shopId!, [updated]);
    return toAdminProduct(shown);
  });

  // ── DELETE /api/admin/products/:id — soft delete ─────────────────────
  fastify.delete<{ Params: { id: string } }>("/:id", { preHandler: centralAdminOnly("remove catalog products") }, async (request, reply) => {
    const admin = request.authUser!;
    const existing = await getProductInBranchCatalogOrThrow(prisma, request.params.id, admin.shopId!);
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
