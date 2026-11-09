import type { Prisma, PrismaClient } from "@prisma/client";
import { Errors } from "./errors.js";
import { getInventoryMode } from "../services/inventoryService.js";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * Phase 2 Stage 2.4 — exactly ONE Cashier per branch.
 *
 * A branch may have at most one Cashier whose status is ACTIVE or
 * PENDING_ADMIN_APPROVAL. REJECTED / SUSPENDED Cashiers don't count, which is
 * what makes replacement possible: suspend the current Cashier (all history,
 * bills and sessions stay exactly as they are), then the replacement can sign
 * up and be approved. Stock is never involved — it belongs to the branch.
 *
 * Enforced twice:
 *   1. here, at application level, inside the same transaction that changes a
 *      Cashier's status or branch, serialised per branch by a transaction-
 *      scoped advisory lock (so two concurrent requests can't both pass);
 *   2. by the partial unique index in prisma/prepared/02_one_cashier_per_branch.sql,
 *      which is applied only after existing conflicts are resolved by the owner.
 */
const OPEN_STATUSES = ["ACTIVE", "PENDING_ADMIN_APPROVAL"] as const;

/** Serialises every "who is this branch's Cashier" decision for one branch. Call inside a transaction. */
export async function lockBranchCashierSlot(tx: Db, shopId: string): Promise<void> {
  // `::text` because Prisma cannot deserialize the lock function's `void` result.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${"branch-cashier:" + shopId}))::text AS locked`;
}

/** Throws 409 if the branch already has another ACTIVE/PENDING Cashier (other than `excludeUserId`). */
export async function assertBranchCashierSlotFree(tx: Db, shopId: string, excludeUserId?: string): Promise<void> {
  const other = await tx.user.findFirst({
    where: {
      shopId,
      role: "CASHIER",
      status: { in: [...OPEN_STATUSES] },
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
    select: { id: true },
  });
  if (other) {
    throw Errors.conflict(
      "This branch already has a cashier. To replace them, suspend the current cashier first.",
      "BRANCH_HAS_CASHIER"
    );
  }
}

/**
 * Replacement safety (pre-cutover only): refuses to activate a Cashier at a
 * branch while a DIFFERENT Cashier still owns non-zero legacy stock there.
 * After the BranchInventory cutover stock belongs to the branch, so this
 * never applies and replacement is always safe.
 */
export async function assertNoStrandedCashierStock(tx: Db, shopId: string, newCashierId: string): Promise<void> {
  if ((await getInventoryMode(tx)) === "BRANCH") return;
  const stranded = await tx.cashierInventory.findFirst({
    where: { shopId, cashierId: { not: newCashierId }, quantity: { not: 0 } },
    select: { id: true },
  });
  if (stranded) {
    throw Errors.conflict(
      "This branch's stock is still assigned to its previous cashier. Complete the branch inventory cutover before replacing a cashier, so the branch's stock is not reset.",
      "REPLACEMENT_REQUIRES_BRANCH_INVENTORY"
    );
  }
}
