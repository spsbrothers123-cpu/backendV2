import type { Prisma, PrismaClient } from "@prisma/client";
import { round2, type Money } from "./money.js";

/**
 * RBR Egg Mart V2 — Phase 2, Stage 2.5: common price + optional branch override.
 *
 *   effective price = BranchProduct.priceOverride, otherwise Product.sellingPrice
 *
 * - Product.sellingPrice is the common default. Changing it never touches a
 *   branch override (the two live in different tables/columns).
 * - A priceOverride of 0 is a deliberate override (not "unset"); only NULL
 *   means "inherit the common price".
 * - Historical bills are unaffected: BillItem.unitPrice is a snapshot written
 *   at checkout and is never recomputed from these functions.
 * - The CLIENT never supplies an authoritative price. Billing resolves it here,
 *   on the server, from the database.
 */

type Db = Prisma.TransactionClient | PrismaClient;

/** Pure rule — the single definition of "effective price". */
export function effectivePrice(sellingPrice: Money, priceOverride: Money | null | undefined): Money {
  return round2(priceOverride != null ? priceOverride : sellingPrice);
}

/**
 * Effective price per product for ONE branch. Reads the branch's
 * BranchProduct override rows in a single query. Products with no
 * BranchProduct row (or a NULL override) fall back to the common price.
 */
export async function getEffectivePrices(
  db: Db,
  shopId: string,
  products: { id: string; sellingPrice: Money }[]
): Promise<Map<string, Money>> {
  const out = new Map<string, Money>();
  if (products.length === 0) return out;
  const rows = await db.branchProduct.findMany({
    where: { shopId, productId: { in: products.map((p) => p.id) } },
    select: { productId: true, priceOverride: true },
  });
  const overrides = new Map(rows.map((r) => [r.productId, r.priceOverride]));
  for (const p of products) out.set(p.id, effectivePrice(p.sellingPrice, overrides.get(p.id)));
  return out;
}
