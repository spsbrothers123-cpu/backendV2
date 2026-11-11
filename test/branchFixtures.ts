/**
 * Shared integration-test fixtures for the branch-catalog architecture.
 *
 * Rules these helpers encode (src/lib/branchCatalog.ts, inventoryService.ts):
 *  - A product is visible/sellable at a branch ONLY through a BranchProduct
 *    row with isAssigned = true. Product.shopId is legacy origin metadata.
 *  - Stock lives in the table the active inventory mode reads:
 *      CASHIER mode -> CashierInventory (shop + cashier + product)
 *      BRANCH mode  -> BranchInventory  (shop + product)
 *
 * Put this file at test/branchFixtures.ts.
 */
import type { Prisma, Product } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";
import { getInventoryMode } from "../src/services/inventoryService.js";

/**
 * Creates a catalog product and assigns it to EXACTLY ONE branch
 * (`data.shopId`). It deliberately does not use assignProductToAllBranches,
 * so isolation tests keep each product visible at a single branch.
 */
export async function createAssignedProduct(data: Prisma.ProductUncheckedCreateInput): Promise<Product> {
  const product = await prisma.product.create({ data });
  await prisma.branchProduct.create({
    data: { shopId: data.shopId, productId: product.id, isAssigned: true },
  });
  return product;
}

/**
 * Seeds `quantity` units of stock in whichever table the current inventory
 * mode treats as authoritative. Does not touch Product.stock (the aggregate):
 * set it when creating the product, as the tests always have.
 */
export async function seedStock(shopId: string, cashierId: string, productId: string, quantity: number): Promise<void> {
  const mode = await getInventoryMode(prisma);
  if (mode === "BRANCH") {
    await prisma.branchInventory.upsert({
      where: { shopId_productId: { shopId, productId } },
      create: { shopId, productId, quantity },
      update: { quantity },
    });
    return;
  }
  await prisma.cashierInventory.upsert({
    where: { shopId_cashierId_productId: { shopId, cashierId, productId } },
    create: { shopId, cashierId, productId, quantity },
    update: { quantity },
  });
}
