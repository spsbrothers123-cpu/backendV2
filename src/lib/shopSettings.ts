import { prisma } from "./prisma.js";
import type { ShopSettings } from "@prisma/client";

/**
 * Every shop gets its settings row lazily, on first read or write, rather
 * than at shop-creation time — keeps shop creation (signup) simple and
 * settings entirely optional until an admin actually visits the page.
 */
export async function getOrCreateShopSettings(shopId: string): Promise<ShopSettings> {
  const existing = await prisma.shopSettings.findUnique({ where: { shopId } });
  if (existing) return existing;
  return prisma.shopSettings.upsert({
    where: { shopId },
    update: {},
    create: { shopId },
  });
}
