import type { Prisma, PrismaClient, Product } from "@prisma/client";
import { Errors } from "./errors.js";

/**
 * RBR Egg Mart V2 — Phase 2, Stage 2.2: Global Product Catalog.
 *
 * Product rows (existing IDs preserved) are the global catalog.
 * BranchProduct decides which branch (Shop) carries which product:
 *
 *   isAssigned = true   -> the branch sells/stocks/sees the product
 *   isAssigned = false  -> hidden from the branch. Nothing is deleted:
 *                          stock rows, movements and bills are untouched,
 *                          so re-assigning restores the preserved stock.
 *
 * "Unassigned" (a BranchProduct row with isAssigned = false) is deliberately
 * distinct from "inactive" (Product.status = INACTIVE, a catalog-wide flag).
 *
 * Product.shopId is legacy ORIGIN metadata only — nothing in here (or in any
 * visibility check) reads it.
 */

type Db = Prisma.TransactionClient | PrismaClient;

/** Prisma `where` fragment: products currently assigned to `shopId`. */
export function assignedToShop(shopId: string): Prisma.ProductWhereInput {
  return { branchProducts: { some: { shopId, isAssigned: true } } };
}

/**
 * Loads a product only if it is currently ASSIGNED to the branch; otherwise
 * behaves exactly like "product does not exist" (never leaks that the product
 * exists elsewhere or is merely hidden here).
 */
export async function getAssignedProductOrThrow(db: Db, productId: string, shopId: string): Promise<Product> {
  const product = await db.product.findFirst({ where: { id: productId, ...assignedToShop(shopId) } });
  if (!product) throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
  return product;
}

/**
 * Admin-side catalog access: the product must have a BranchProduct row for
 * the branch (assigned OR unassigned), so an admin can still find a hidden
 * product to re-assign or edit it.
 */
export async function getProductInBranchCatalogOrThrow(db: Db, productId: string, shopId: string): Promise<Product> {
  const product = await db.product.findFirst({ where: { id: productId, branchProducts: { some: { shopId } } } });
  if (!product) throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
  return product;
}

/**
 * New product -> assigned to EVERY existing branch (assignment only; stock
 * is never created or touched here). Idempotent: existing rows are left as
 * they are, so it can never flip a deliberate unassignment back on.
 */
export async function assignProductToAllBranches(
  db: Db,
  productId: string,
  actorId: string | null
): Promise<{ created: number }> {
  const shops = await db.shop.findMany({ select: { id: true } });
  if (shops.length === 0) return { created: 0 };
  const result = await db.branchProduct.createMany({
    data: shops.map((s) => ({ shopId: s.id, productId, isAssigned: true, assignedById: actorId })),
    skipDuplicates: true,
  });
  return { created: result.count };
}

/**
 * New branch -> assigned EVERY existing global product (active and
 * inactive; Product.status stays an independent flag). Branch stock starts
 * at zero simply because no stock rows are created: this function never
 * writes inventory. Idempotent.
 */
export async function assignAllProductsToBranch(
  db: Db,
  shopId: string,
  actorId: string | null
): Promise<{ created: number }> {
  const products = await db.product.findMany({ select: { id: true } });
  if (products.length === 0) return { created: 0 };
  const result = await db.branchProduct.createMany({
    data: products.map((p) => ({ shopId, productId: p.id, isAssigned: true, assignedById: actorId })),
    skipDuplicates: true,
  });
  return { created: result.count };
}

export type AssignmentChange = { changed: boolean; isAssigned: boolean };

/**
 * Assign / unassign one product at one branch. Touches ONLY the
 * BranchProduct row — never stock, movements, bills or the price override.
 * Re-assigning an unassigned product keeps whatever stock it had.
 * Idempotent: repeating the same request reports changed = false.
 */
export async function setBranchAssignment(
  db: Db,
  input: { shopId: string; productId: string; assigned: boolean; actorId: string }
): Promise<AssignmentChange> {
  const { shopId, productId, assigned, actorId } = input;
  const existing = await db.branchProduct.findUnique({ where: { shopId_productId: { shopId, productId } } });

  if (!existing) {
    // Heals a missing row (e.g. a product created while a branch was being
    // created): assigned -> create assigned; unassigned -> create hidden.
    await db.branchProduct.create({
      data: {
        shopId,
        productId,
        isAssigned: assigned,
        assignedById: assigned ? actorId : null,
        ...(assigned ? {} : { unassignedAt: new Date(), unassignedById: actorId }),
      },
    });
    return { changed: true, isAssigned: assigned };
  }
  if (existing.isAssigned === assigned) return { changed: false, isAssigned: assigned };

  await db.branchProduct.update({
    where: { shopId_productId: { shopId, productId } },
    data: assigned
      ? { isAssigned: true, assignedAt: new Date(), assignedById: actorId, unassignedAt: null, unassignedById: null }
      : { isAssigned: false, unassignedAt: new Date(), unassignedById: actorId },
  });
  return { changed: true, isAssigned: assigned };
}

