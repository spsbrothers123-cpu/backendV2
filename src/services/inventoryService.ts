import type { Prisma, PrismaClient, StockMovementType } from "@prisma/client";
import { Errors } from "../lib/errors.js";

interface AdjustStockInput {
  shopId: string;
  /**
   * Whose CashierInventory row this change applies to. Cashier-level
   * inventory foundation: every unit of stock belongs to exactly one
   * cashier, never a shared shop-wide pool — so this is required for
   * every call site (sale, purchase intake, manual adjustment). Callers
   * must resolve this server-side (the authenticated cashier for a sale,
   * or an admin-selected cashier already verified with
   * assertCashierBelongsToShop) — never trust it from an unrelated party.
   */
  cashierId: string;
  productId: string;
  /** Signed delta: positive increases stock, negative decreases it. */
  delta: number;
  type: StockMovementType;
  reason: string;
  /**
   * Who performed the action. Equal to cashierId for a POS sale; the
   * acting admin's id for a purchase or manual adjustment made on a
   * cashier's behalf.
   */
  actorId?: string | null;
}

/**
 * Applies a stock change atomically, scoped to one cashier's inventory,
 * and records the movement. Used by:
 *  - billing (SALE, negative delta, inside the checkout transaction) —
 *    decrements the selling cashier's own CashierInventory row.
 *  - admin manual adjustments (ADJUSTMENT, either sign) — targets whichever
 *    cashier the admin selected.
 *  - purchases (IN, positive delta) — targets whichever cashier the admin
 *    selected to receive the purchased stock.
 *
 * Product.stock is maintained alongside CashierInventory.quantity as a
 * denormalized SUM across every cashier for that product (for shop-wide
 * Admin views only — see the schema doc comment). A single cashier's
 * delta changes that sum by the same delta, so it's updated in place
 * rather than re-aggregated.
 *
 * Concurrency safety: the CashierInventory change is a single conditional
 * UPDATE (`quantity = quantity + delta WHERE quantity + delta >= 0`),
 * which Postgres executes atomically per-row regardless of transaction
 * isolation level. Two concurrent decrements racing for the last units of
 * the SAME cashier's stock will never both succeed — the loser's WHERE
 * clause fails to match and updatedCount is 0. Two different cashiers'
 * stock never contends with each other at all, by construction.
 */
export async function adjustStock(
  tx: Prisma.TransactionClient | PrismaClient,
  input: AdjustStockInput
): Promise<{ previousStock: number; newStock: number }> {
  const product = await tx.product.findUnique({ where: { id: input.productId } });
  if (!product || product.shopId !== input.shopId) {
    throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
  }

  const inventoryKey = {
    shopId_cashierId_productId: {
      shopId: input.shopId,
      cashierId: input.cashierId,
      productId: input.productId,
    },
  };

  if (input.delta === 0) {
    const existing = await tx.cashierInventory.findUnique({ where: inventoryKey });
    const qty = existing?.quantity ?? 0;
    return { previousStock: qty, newStock: qty };
  }

  // Ensure a row exists for this (shop, cashier, product) triple so the
  // conditional UPDATE below always has something to match — a cashier
  // who has never touched this product yet starts at 0, same as if the
  // row had always existed.
  await tx.cashierInventory.upsert({
    where: inventoryKey,
    create: { shopId: input.shopId, cashierId: input.cashierId, productId: input.productId, quantity: 0 },
    update: {},
  });

  if (input.delta < 0) {
    const result = await tx.cashierInventory.updateMany({
      where: {
        shopId: input.shopId,
        cashierId: input.cashierId,
        productId: input.productId,
        quantity: { gte: -input.delta },
      },
      data: { quantity: { decrement: -input.delta } },
    });
    if (result.count === 0) {
      const current = await tx.cashierInventory.findUnique({ where: inventoryKey });
      throw Errors.conflict(
        `Insufficient stock for "${product.name}". Available: ${current?.quantity ?? 0}.`,
        "INSUFFICIENT_STOCK"
      );
    }
  } else {
    await tx.cashierInventory.update({
      where: inventoryKey,
      data: { quantity: { increment: input.delta } },
    });
  }

  // Keep the shop-wide denormalized total in sync in the same transaction.
  await tx.product.update({
    where: { id: input.productId },
    data: { stock: { increment: input.delta } },
  });

  const updatedRow = await tx.cashierInventory.findUniqueOrThrow({ where: inventoryKey });
  const previousStock = updatedRow.quantity - input.delta;

  await tx.inventoryMovement.create({
    data: {
      shopId: input.shopId,
      productId: input.productId,
      cashierId: input.cashierId,
      type: input.type,
      quantity: input.delta,
      previousStock,
      newStock: updatedRow.quantity,
      reason: input.reason,
      actorId: input.actorId ?? null,
    },
  });

  return { previousStock, newStock: updatedRow.quantity };
}

/**
 * A specific cashier's current quantity for a product — 0 if they've never
 * had any (no row yet). This is the ONLY correct way to answer "how much
 * stock does this cashier have"; never Product.stock, which is a
 * shop-wide aggregate across every cashier.
 */
export async function getCashierStock(
  tx: Prisma.TransactionClient | PrismaClient,
  shopId: string,
  cashierId: string,
  productId: string
): Promise<number> {
  const row = await tx.cashierInventory.findUnique({
    where: { shopId_cashierId_productId: { shopId, cashierId, productId } },
  });
  return row?.quantity ?? 0;
}

/**
 * Bulk version of getCashierStock for listing endpoints — returns a Map
 * from productId to that cashier's quantity (0 for any productId not in
 * the returned map).
 */
export async function getCashierStockMap(
  tx: Prisma.TransactionClient | PrismaClient,
  shopId: string,
  cashierId: string,
  productIds: string[]
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  const rows = await tx.cashierInventory.findMany({
    where: { shopId, cashierId, productId: { in: productIds } },
  });
  return new Map(rows.map((r) => [r.productId, r.quantity]));
}
