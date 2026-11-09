import { prisma } from "./prisma.js";
import { Errors } from "./errors.js";
import { assertCashierBelongsToShop } from "./cashierAccess.js";
import { getInventoryMode } from "../services/inventoryService.js";

/**
 * Resolves the optional `cashierId` an Admin may send with a stock change.
 *
 *   CASHIER mode (before cutover): stock is cashier-owned, so it is
 *     REQUIRED and verified to belong to the shop — exactly as before.
 *   BRANCH mode (after cutover): stock belongs to the branch. The cashier
 *     is optional actor metadata; when supplied it is still verified.
 *
 * Returns the verified cashier id, or null.
 */
export async function resolveStockCashier(shopId: string, cashierId: string | undefined): Promise<string | null> {
  if (!cashierId) {
    if ((await getInventoryMode(prisma)) === "CASHIER") {
      throw Errors.validation("Select which cashier this stock change applies to.");
    }
    return null;
  }
  await assertCashierBelongsToShop(shopId, cashierId);
  return cashierId;
}
