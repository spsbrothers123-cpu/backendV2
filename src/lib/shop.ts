import { prisma } from "./prisma.js";
import { Errors } from "./errors.js";

/**
 * Resolves which shop a new cashier signup belongs to. The frontend never
 * sends a shopId (and it would never be trusted if it did — see Phase 1
 * spec §31 Shop Isolation). Phase 1 ships as a single-shop deployment, so
 * this simply resolves the one seeded Shop. When Egg Mart grows to
 * multiple shops, replace this with real resolution (e.g. an admin-issued
 * invite/shop code) without touching any call site — every caller goes
 * through this one function.
 */
export async function resolveSignupShop() {
  const shop = await prisma.shop.findFirst({ orderBy: { createdAt: "asc" } });
  if (!shop) {
    throw Errors.internal("No shop is configured yet. Run the seed script before accepting signups.");
  }
  return shop;
}
