import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { assertCentralAdmin } from "../../lib/centralAdmin.js";
import { setBranchAssignment } from "../../lib/branchCatalog.js";
import { effectivePrice } from "../../lib/pricing.js";
import { round2, toDecimal, toNumber } from "../../lib/money.js";

/**
 * Phase 2 Stage 2.2 — per-branch product assignment.
 *
 * Central Admin only (CENTRAL_ADMIN_USER_ID; fails closed when unset), and
 * deliberately independent of the Global Shop Selector: the Central Admin
 * manages assignment for ANY branch, not just the selected one.
 *
 * Unassigning hides the product from the branch. It never deletes or alters
 * stock, inventory movements, bills or purchases; re-assigning restores the
 * branch exactly as it was.
 */
const assignBody = z.object({ assigned: z.boolean() });

// Stage 2.5: `null` clears the override (branch inherits the common price).
// 0 is a valid, deliberate override. Mirrors the DB CHECK (>= 0) and
// DECIMAL(12,2) range.
const priceBody = z.object({
  priceOverride: z.number().finite().min(0).max(9_999_999_999.99).nullable(),
});

export default async function adminBranchProductsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  fastify.addHook("preHandler", async (request) => {
    assertCentralAdmin(request.authUser);
  });

  // ── GET /api/admin/branch-products/:productId ─────────────────────────
  // Assignment state of one product at EVERY branch.
  fastify.get<{ Params: { productId: string } }>("/:productId", async (request) => {
    const product = await prisma.product.findUnique({ where: { id: request.params.productId } });
    if (!product) throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");

    const [shops, rows] = await Promise.all([
      prisma.shop.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.branchProduct.findMany({ where: { productId: product.id } }),
    ]);
    const byShop = new Map(rows.map((r) => [r.shopId, r]));

    return {
      productId: product.id,
      productName: product.name,
      // Catalog-wide flag, reported separately from per-branch assignment.
      status: product.status === "ACTIVE" ? "active" : "inactive",
      // Common default price; each branch below reports its own override and
      // the resulting effective price.
      sellingPrice: toNumber(product.sellingPrice),
      branches: shops.map((s) => {
        const r = byShop.get(s.id);
        return {
          shopId: s.id,
          name: s.name,
          code: s.code,
          location: s.location,
          assigned: r?.isAssigned ?? false,
          priceOverride: r?.priceOverride != null ? toNumber(r.priceOverride) : null,
          effectivePrice: toNumber(effectivePrice(product.sellingPrice, r?.priceOverride)),
          hasAssignmentRecord: !!r,
          assignedAt: r?.assignedAt?.toISOString() ?? null,
          unassignedAt: r?.unassignedAt?.toISOString() ?? null,
        };
      }),
    };
  });

  // ── PUT /api/admin/branch-products/:productId/:shopId ─────────────────
  fastify.put<{ Params: { productId: string; shopId: string } }>("/:productId/:shopId", async (request) => {
    const admin = request.authUser!;
    const { assigned } = parseBody(assignBody, request.body);
    const { productId, shopId } = request.params;

    const [product, shop] = await Promise.all([
      prisma.product.findUnique({ where: { id: productId } }),
      prisma.shop.findUnique({ where: { id: shopId } }),
    ]);
    if (!product) throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
    if (!shop) throw Errors.notFound("Shop not found.", "SHOP_NOT_FOUND");

    const result = await prisma.$transaction((tx) =>
      setBranchAssignment(tx, { shopId, productId, assigned, actorId: admin.id })
    );

    if (result.changed) {
      await recordAudit({
        action: assigned ? "PRODUCT_ASSIGNED" : "PRODUCT_UNASSIGNED",
        actorId: admin.id,
        actorRole: "ADMIN",
        shopId,
        entityType: "Product",
        entityId: productId,
      });
    }

    return { productId, shopId, assigned: result.isAssigned, changed: result.changed };
  });

  // ── PUT /api/admin/branch-products/:productId/:shopId/price ───────────
  // Stage 2.5: set (number) or clear (null) ONE branch's price override.
  // Touches only BranchProduct.priceOverride — never Product.sellingPrice,
  // stock, movements or any bill. Historical bills keep their own snapshot
  // unit prices. Works for unassigned rows too (the override is preserved
  // across un/re-assignment). Idempotent: an unchanged value reports
  // changed = false and writes no audit row.
  fastify.put<{ Params: { productId: string; shopId: string } }>("/:productId/:shopId/price", async (request) => {
    const admin = request.authUser!;
    const { priceOverride } = parseBody(priceBody, request.body);
    const { productId, shopId } = request.params;

    const next = priceOverride == null ? null : round2(toDecimal(priceOverride));

    const result = await prisma.$transaction(async (tx) => {
      const row = await tx.branchProduct.findUnique({
        where: { shopId_productId: { shopId, productId } },
        include: { product: true },
      });
      if (!row) throw Errors.notFound("Product is not part of this branch's catalog.", "BRANCH_PRODUCT_NOT_FOUND");

      const previous = row.priceOverride;
      const unchanged = (previous == null && next == null) || (previous != null && next != null && previous.equals(next));
      if (!unchanged) {
        await tx.branchProduct.update({ where: { shopId_productId: { shopId, productId } }, data: { priceOverride: next } });
      }
      return { changed: !unchanged, previous, product: row.product };
    });

    if (result.changed) {
      await recordAudit({
        action: next == null ? "PRICE_OVERRIDE_CLEARED" : "PRICE_OVERRIDE_SET",
        actorId: admin.id,
        actorRole: "ADMIN",
        shopId,
        entityType: "Product",
        entityId: productId,
        metadata: {
          previousOverride: result.previous != null ? toNumber(result.previous) : null,
          newOverride: next != null ? toNumber(next) : null,
          commonPrice: toNumber(result.product.sellingPrice),
        },
      });
    }

    return {
      productId,
      shopId,
      priceOverride: next != null ? toNumber(next) : null,
      effectivePrice: toNumber(effectivePrice(result.product.sellingPrice, next)),
      changed: result.changed,
    };
  });
}
