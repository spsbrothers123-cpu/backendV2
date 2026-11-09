import type { User } from "@prisma/client";
import { prisma } from "./prisma.js";
import { Errors } from "./errors.js";

/**
 * Cashier-level inventory foundation: whenever an Admin picks a cashier to
 * target (purchase intake, manual adjustment, initial product stock), the
 * backend independently verifies that cashier actually belongs to the
 * admin's own shop before trusting the id — never trust a
 * frontend-supplied cashierId at face value, even one an admin selected
 * from what should be a same-shop dropdown.
 *
 * Requires the cashier to be ACTIVE and belong to shopId — never another
 * shop, never another admin/tenant's cashier.
 */
export async function assertCashierBelongsToShop(shopId: string, cashierId: string): Promise<User> {
  const cashier = await prisma.user.findUnique({ where: { id: cashierId } });
  if (!cashier || cashier.role !== "CASHIER" || cashier.shopId !== shopId || cashier.status !== "ACTIVE") {
    throw Errors.badRequest(
      "Selected cashier does not belong to this shop.",
      "CASHIER_NOT_IN_SHOP"
    );
  }
  return cashier;
}
