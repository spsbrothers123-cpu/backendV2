import type { Prisma, PrismaClient, StockMovementType } from "@prisma/client";
import { Errors } from "../lib/errors.js";

interface AdjustStockInput {
  shopId: string;
  productId: string;
  /** Signed delta: positive increases stock, negative decreases it. */
  delta: number;
  type: StockMovementType;
  reason: string;
  actorId?: string | null;
}

/**
 * Applies a stock change atomically and records the movement. Used by:
 *  - billing (SALE, negative delta, inside the checkout transaction)
 *  - admin manual adjustments (ADJUSTMENT, either sign)
 *  - purchases (IN, positive delta)
 *
 * Concurrency safety: the stock change is a single conditional UPDATE
 * (`stock = stock + delta WHERE stock + delta >= 0`), which Postgres
 * executes atomically per-row regardless of transaction isolation level.
 * Two concurrent decrements racing for the last units will never both
 * succeed — the loser's WHERE clause fails to match and updatedCount is 0.
 */
export async function adjustStock(
  tx: Prisma.TransactionClient | PrismaClient,
  input: AdjustStockInput
): Promise<{ previousStock: number; newStock: number }> {
  const product = await tx.product.findUnique({ where: { id: input.productId } });
  if (!product || product.shopId !== input.shopId) {
    throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
  }

  if (input.delta === 0) {
    return { previousStock: product.stock, newStock: product.stock };
  }

  if (input.delta < 0) {
    const result = await tx.product.updateMany({
      where: { id: input.productId, shopId: input.shopId, stock: { gte: -input.delta } },
      data: { stock: { decrement: -input.delta } },
    });
    if (result.count === 0) {
      throw Errors.conflict(
        `Insufficient stock for "${product.name}". Available: ${product.stock}.`,
        "INSUFFICIENT_STOCK"
      );
    }
  } else if (input.delta > 0) {
    await tx.product.update({
      where: { id: input.productId },
      data: { stock: { increment: input.delta } },
    });
  }

  const updated = await tx.product.findUniqueOrThrow({ where: { id: input.productId } });
  const previousStock = updated.stock - input.delta;

  await tx.inventoryMovement.create({
    data: {
      shopId: input.shopId,
      productId: input.productId,
      type: input.type,
      quantity: input.delta,
      previousStock,
      newStock: updated.stock,
      reason: input.reason,
      actorId: input.actorId ?? null,
    },
  });

  return { previousStock, newStock: updated.stock };
}
