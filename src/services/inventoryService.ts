import type { Prisma, PrismaClient, Product, StockMovementType } from "@prisma/client";
import { Errors } from "../lib/errors.js";
import { assignedToShop } from "../lib/branchCatalog.js";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Which table is the AUTHORITATIVE stock source (Phase 2 Stage 2.3).
 *
 *   CASHIER — legacy: CashierInventory rows are the source (default until the
 *             authorized cutover; behaviour identical to Stages <= 2.2).
 *   BRANCH  — BranchInventory (one row per branch + product) is the source.
 *             CashierInventory receives NO new writes.
 *
 * Stored in system_flags('inventory_source'); flipped only by the cutover
 * script, atomically with the verified backfill.
 */
export type InventoryMode = "CASHIER" | "BRANCH";

const FLAG_KEY = "inventory_source";

/**
 * Reads the inventory source.
 *
 * `lock: true` takes a SHARED row lock on the flag, held until the calling
 * transaction ends. Every stock-changing transaction does this, and the
 * cutover takes the same row FOR UPDATE — so the switch waits for in-flight
 * stock transactions and no new one can start until it commits. Shared locks
 * never block each other, so normal traffic is unaffected. Pass a
 * transaction client when locking; outside a transaction the lock is
 * released immediately (fine for read-only display).
 *
 * A missing row (migration not applied yet) is treated as CASHIER: the safe,
 * legacy behaviour.
 */
export async function getInventoryMode(db: Db, opts: { lock?: boolean } = {}): Promise<InventoryMode> {
  const rows = opts.lock
    ? await db.$queryRaw<{ value: string }[]>`SELECT "value" FROM "system_flags" WHERE "key" = ${FLAG_KEY} FOR SHARE`
    : await db.$queryRaw<{ value: string }[]>`SELECT "value" FROM "system_flags" WHERE "key" = ${FLAG_KEY}`;
  return rows[0]?.value === "BRANCH" ? "BRANCH" : "CASHIER";
}

interface AdjustStockInput {
  shopId: string;
  /**
   * CASHIER mode: whose CashierInventory row this change applies to —
   * required (stock is cashier-owned).
   * BRANCH mode: ACTOR METADATA ONLY. Stock belongs to the branch, so this
   * never decides which row changes; it is just recorded on the movement
   * (the selling cashier for a sale). Optional.
   */
  cashierId?: string | null;
  productId: string;
  /** Signed delta: positive increases stock, negative decreases it. */
  delta: number;
  type: StockMovementType;
  reason: string;
  /**
   * Who performed the action. Equal to cashierId for a POS sale; the
   * acting admin's id for a purchase or manual adjustment.
   */
  actorId?: string | null;
  /**
   * Stage 2.7: stock RESTORATION for a cancelled bill must reach the bill's
   * original branch even if the product was unassigned there afterwards
   * (unassigning hides a product but preserves its stock). When true the
   * product need only exist; it is never used for sales or purchases.
   */
  allowUnassigned?: boolean;
}

/**
 * Applies a stock change atomically and records the movement. Used by
 * billing (SALE), admin adjustments (ADJUSTMENT) and purchases (IN).
 *
 * Product.stock is the derived aggregate across ALL branches and is kept in
 * step by the same delta, in the same transaction, in both modes.
 *
 * Concurrency: the decrement is a single conditional UPDATE
 * (`quantity = quantity - n WHERE quantity >= n`), executed atomically per
 * row by Postgres at any isolation level. Two concurrent requests for the
 * last unit can never both succeed — the loser matches zero rows.
 * (Branch mode serialises on the one BranchInventory row of that
 * branch+product, which is exactly the contention that must be serialised.)
 */
export async function adjustStock(
  tx: Db,
  input: AdjustStockInput
): Promise<{ previousStock: number; newStock: number }> {
  // Shared lock on the source flag for the rest of this transaction.
  const mode = await getInventoryMode(tx, { lock: true });

  // Stage 2.2: the product must be ASSIGNED to this branch (BranchProduct),
  // not merely have originated here (Product.shopId is legacy metadata).
  // Same error as "no such product", so an unassigned/foreign product's
  // existence is never revealed.
  const product = await tx.product.findFirst({
    where: input.allowUnassigned
      ? { id: input.productId, branchProducts: { some: { shopId: input.shopId } } }
      : { id: input.productId, ...assignedToShop(input.shopId) },
  });
  if (!product) {
    throw Errors.notFound("Product not found.", "PRODUCT_NOT_FOUND");
  }

  return mode === "BRANCH" ? adjustBranchStock(tx, input, product) : adjustCashierStock(tx, input, product);
}

// ── BRANCH mode (authoritative: BranchInventory) ─────────────────────────
async function adjustBranchStock(
  tx: Db,
  input: AdjustStockInput,
  product: Product
): Promise<{ previousStock: number; newStock: number }> {
  const key = { shopId_productId: { shopId: input.shopId, productId: input.productId } };

  if (input.delta === 0) {
    const existing = await tx.branchInventory.findUnique({ where: key });
    const qty = existing?.quantity ?? 0;
    return { previousStock: qty, newStock: qty };
  }

  // Make sure the row exists so the conditional UPDATE below has something
  // to match (INSERT … ON CONFLICT DO NOTHING — race-safe).
  await tx.branchInventory.createMany({
    data: [{ shopId: input.shopId, productId: input.productId, quantity: 0 }],
    skipDuplicates: true,
  });

  if (input.delta < 0) {
    const result = await tx.branchInventory.updateMany({
      where: { shopId: input.shopId, productId: input.productId, quantity: { gte: -input.delta } },
      data: { quantity: { decrement: -input.delta } },
    });
    if (result.count === 0) {
      const current = await tx.branchInventory.findUnique({ where: key });
      throw Errors.conflict(
        `Insufficient stock for "${product.name}". Available: ${current?.quantity ?? 0}.`,
        "INSUFFICIENT_STOCK"
      );
    }
  } else {
    await tx.branchInventory.update({ where: key, data: { quantity: { increment: input.delta } } });
  }

  // Aggregate across branches, same transaction.
  await tx.product.update({ where: { id: input.productId }, data: { stock: { increment: input.delta } } });

  const row = await tx.branchInventory.findUniqueOrThrow({ where: key });
  const previousStock = row.quantity - input.delta;

  await tx.inventoryMovement.create({
    data: {
      shopId: input.shopId,
      productId: input.productId,
      // Actor metadata only — never stock ownership.
      cashierId: input.cashierId ?? null,
      type: input.type,
      quantity: input.delta,
      previousStock,
      newStock: row.quantity,
      reason: input.reason,
      actorId: input.actorId ?? null,
    },
  });

  return { previousStock, newStock: row.quantity };
}

// ── CASHIER mode (legacy, until cutover) ─────────────────────────────────
async function adjustCashierStock(
  tx: Db,
  input: AdjustStockInput,
  product: Product
): Promise<{ previousStock: number; newStock: number }> {
  if (!input.cashierId) {
    throw Errors.validation("Select which cashier this stock change applies to.");
  }
  const cashierId = input.cashierId;

  const inventoryKey = {
    shopId_cashierId_productId: { shopId: input.shopId, cashierId, productId: input.productId },
  };

  if (input.delta === 0) {
    const existing = await tx.cashierInventory.findUnique({ where: inventoryKey });
    const qty = existing?.quantity ?? 0;
    return { previousStock: qty, newStock: qty };
  }

  // Ensure a row exists for this (shop, cashier, product) triple so the
  // conditional UPDATE below always has something to match.
  await tx.cashierInventory.upsert({
    where: inventoryKey,
    create: { shopId: input.shopId, cashierId, productId: input.productId, quantity: 0 },
    update: {},
  });

  if (input.delta < 0) {
    const result = await tx.cashierInventory.updateMany({
      where: { shopId: input.shopId, cashierId, productId: input.productId, quantity: { gte: -input.delta } },
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
    await tx.cashierInventory.update({ where: inventoryKey, data: { quantity: { increment: input.delta } } });
  }

  await tx.product.update({ where: { id: input.productId }, data: { stock: { increment: input.delta } } });

  const updatedRow = await tx.cashierInventory.findUniqueOrThrow({ where: inventoryKey });
  const previousStock = updatedRow.quantity - input.delta;

  await tx.inventoryMovement.create({
    data: {
      shopId: input.shopId,
      productId: input.productId,
      cashierId,
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
 * New Cashier Initialization (legacy, CASHIER mode only).
 *
 * Creates a zero-quantity CashierInventory row for every product assigned to
 * the branch. After the BranchInventory cutover CashierInventory must not
 * receive new writes, so this is a no-op in BRANCH mode (the cashier simply
 * sees the branch's stock; nothing is owned per cashier).
 */
export async function initializeCashierInventory(
  tx: Db,
  shopId: string,
  cashierId: string
): Promise<{ productsInitialized: number }> {
  if ((await getInventoryMode(tx)) === "BRANCH") return { productsInitialized: 0 };

  const products = await tx.product.findMany({ where: assignedToShop(shopId), select: { id: true } });
  if (products.length === 0) return { productsInitialized: 0 };

  const result = await tx.cashierInventory.createMany({
    data: products.map((p) => ({ shopId, cashierId, productId: p.id, quantity: 0 })),
    skipDuplicates: true,
  });
  return { productsInitialized: result.count };
}

/**
 * Stock a CASHIER sees for one product: their own row in CASHIER mode, the
 * branch quantity in BRANCH mode (the branch has exactly one cashier and
 * stock is not cashier-owned).
 */
export async function getCashierStock(db: Db, shopId: string, cashierId: string, productId: string): Promise<number> {
  const map = await getCashierStockMap(db, shopId, cashierId, [productId]);
  return map.get(productId) ?? 0;
}

/** Bulk version for listing endpoints; absent ids mean 0. */
export async function getCashierStockMap(
  db: Db,
  shopId: string,
  cashierId: string,
  productIds: string[]
): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  if ((await getInventoryMode(db)) === "BRANCH") return getShopStockMap(db, shopId, productIds);
  const rows = await db.cashierInventory.findMany({
    where: { shopId, cashierId, productId: { in: productIds } },
  });
  return new Map(rows.map((r) => [r.productId, r.quantity]));
}

/**
 * Stock of each product AT ONE BRANCH — the correct number for every admin
 * view, whatever the mode (Product.stock is the all-branch aggregate and is
 * wrong for a single branch once a product lives in several).
 *   BRANCH mode:  BranchInventory.quantity.
 *   CASHIER mode: SUM of that branch's CashierInventory rows.
 */
export async function getShopStockMap(db: Db, shopId: string, productIds: string[]): Promise<Map<string, number>> {
  if (productIds.length === 0) return new Map();
  if ((await getInventoryMode(db)) === "BRANCH") {
    const rows = await db.branchInventory.findMany({ where: { shopId, productId: { in: productIds } } });
    return new Map(rows.map((r) => [r.productId, r.quantity]));
  }
  const rows = await db.cashierInventory.groupBy({
    by: ["productId"],
    where: { shopId, productId: { in: productIds } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.productId, r._sum.quantity ?? 0]));
}

/** Same as getShopStockMap but for several branches at once: key `${shopId}:${productId}`. */
export async function getStockByBranchProduct(
  db: Db,
  shopIds: string[],
  productIds: string[]
): Promise<Map<string, number>> {
  if (shopIds.length === 0 || productIds.length === 0) return new Map();
  if ((await getInventoryMode(db)) === "BRANCH") {
    const rows = await db.branchInventory.findMany({
      where: { shopId: { in: shopIds }, productId: { in: productIds } },
    });
    return new Map(rows.map((r) => [`${r.shopId}:${r.productId}`, r.quantity]));
  }
  const rows = await db.cashierInventory.groupBy({
    by: ["shopId", "productId"],
    where: { shopId: { in: shopIds }, productId: { in: productIds } },
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [`${r.shopId}:${r.productId}`, r._sum.quantity ?? 0]));
}

/**
 * Returns the products with `stock` replaced by that BRANCH's stock, so the
 * existing serializers and status labels (which read `.stock`) show branch
 * numbers instead of the all-branch aggregate.
 */
export async function withBranchStock<T extends Product>(db: Db, shopId: string, products: T[]): Promise<T[]> {
  const map = await getShopStockMap(db, shopId, products.map((p) => p.id));
  return products.map((p) => ({ ...p, stock: map.get(p.id) ?? 0 }));
}

/**
 * Stage 3.3 — which of `productIds` have a BranchInventory ROW at this branch.
 *
 * A missing row and a row holding 0 both read as stock 0 (see getShopStockMap),
 * but they mean different things: a missing row is a product that has never
 * been stocked, counted, purchased or sold here; a 0 row is a genuine zero.
 * The answer comes only from row existence — never from the quantity — and it
 * is the same in either inventory mode (it describes BranchInventory itself).
 */
export async function getRecordedProductIds(db: Db, shopId: string, productIds: string[]): Promise<Set<string>> {
  if (productIds.length === 0) return new Set();
  const rows = await db.branchInventory.findMany({
    where: { shopId, productId: { in: productIds } },
    select: { productId: true },
  });
  return new Set(rows.map((r: { productId: string }) => r.productId));
}
