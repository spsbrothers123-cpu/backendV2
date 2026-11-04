import type { Shop } from "@prisma/client";
import { prisma } from "./prisma.js";
import { Errors } from "./errors.js";
import { assignAllProductsToBranch } from "./branchCatalog.js";
import { normalizeShopLocation, shopDisplayName, InvalidShopLocationError } from "./shopLocation.js";

export { SHOP_BRAND_NAME, shopDisplayName } from "./shopLocation.js";

/**
 * Resolves the Shop for a given Shop Location, creating it if this is the
 * first time that location has been used (Phase 1 spec §2/§3). Dedup is
 * enforced at the database level via Shop.code's unique constraint.
 *
 * Deliberately a no-op on an existing match: once a shop exists for a
 * location, a later signup for the same location never renames it or
 * overwrites its `location` value — only the first signup for a given
 * place gets to set its display name.
 */
export async function resolveOrCreateShopByLocation(
  rawLocation: string
): Promise<{ shop: Shop; created: boolean }> {
  let normalized;
  try {
    normalized = normalizeShopLocation(rawLocation);
  } catch (err) {
    if (err instanceof InvalidShopLocationError) {
      throw Errors.validation(`shopLocation: ${err.message}`);
    }
    throw err;
  }
  const { location, code } = normalized;

  const existing = await prisma.shop.findUnique({ where: { code } });
  if (existing) {
    return { shop: existing, created: false };
  }

  // Two concurrent signups for the same brand-new location will race here;
  // the loser's create() hits the unique constraint on `code` and is
  // re-resolved to the winner's row rather than erroring the request.
  try {
    // Phase 2 Stage 2.2: a new branch is assigned EVERY existing global
    // product, atomically with its creation (no half-initialised branch).
    // Assignment only — no stock is created, so branch stock starts at zero.
    const shop = await prisma.$transaction(async (tx) => {
      const created = await tx.shop.create({
        data: { name: shopDisplayName(location), code, location },
      });
      await assignAllProductsToBranch(tx, created.id, null);
      return created;
    });
    return { shop, created: true };
  } catch (err) {
    const shop = await prisma.shop.findUnique({ where: { code } });
    if (shop) {
      return { shop, created: false };
    }
    throw err;
  }
}

/**
 * Phase 2 Stage 2.4 — EXPLICIT branch creation (Central Admin action).
 *
 * Unlike resolveOrCreateShopByLocation this never reuses an existing branch:
 * a location that already exists is a 409, so a typo or a repeat can't
 * silently alias another branch. The new branch is assigned every existing
 * global product atomically (stock starts at zero — nothing is created).
 */
export async function createBranch(rawLocation: string, actorId: string): Promise<Shop> {
  let normalized;
  try {
    normalized = normalizeShopLocation(rawLocation);
  } catch (err) {
    if (err instanceof InvalidShopLocationError) {
      throw Errors.validation(`location: ${err.message}`);
    }
    throw err;
  }
  const { location, code } = normalized;
  const exists = () => Errors.conflict("A branch for this location already exists.", "BRANCH_ALREADY_EXISTS");

  if (await prisma.shop.findUnique({ where: { code } })) throw exists();

  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.shop.create({ data: { name: shopDisplayName(location), code, location } });
      await assignAllProductsToBranch(tx, created.id, actorId);
      return created;
    });
  } catch (err) {
    // Lost a race on the unique `code` — still "already exists", never a 500.
    if ((err as { code?: string }).code === "P2002") throw exists();
    throw err;
  }
}

/**
 * Ensures an AdminShopLink row exists for (adminId, shopId), without
 * erroring if it already does. Used both when an admin signs up for a
 * shop and to self-heal admins created before this table existed (see the
 * AdminShopLink doc comment in schema.prisma).
 */
export async function ensureAdminShopLink(adminId: string, shopId: string): Promise<{ linked: boolean }> {
  const existing = await prisma.adminShopLink.findUnique({
    where: { adminId_shopId: { adminId, shopId } },
  });
  if (existing) {
    return { linked: false };
  }
  await prisma.adminShopLink.create({ data: { adminId, shopId } }).catch(async (err) => {
    // Concurrent request already created it — treat as success.
    const nowExists = await prisma.adminShopLink.findUnique({
      where: { adminId_shopId: { adminId, shopId } },
    });
    if (!nowExists) throw err;
  });
  return { linked: true };
}

/**
 * Every shop the given admin is authorized to access. Falls back to (and
 * self-heals) the admin's current `shopId` for admins with no
 * AdminShopLink rows yet, so this never returns an empty list for an
 * existing, working admin account just because the join table is new.
 */
export async function listShopsForAdmin(adminId: string): Promise<Shop[]> {
  const links = await prisma.adminShopLink.findMany({
    where: { adminId },
    include: { shop: true },
    orderBy: { createdAt: "asc" },
  });

  if (links.length > 0) {
    return links.map((l) => l.shop);
  }

  // No links yet — self-heal from the legacy single-shop admin.shopId.
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  if (!admin?.shopId) {
    return [];
  }
  const shop = await prisma.shop.findUnique({ where: { id: admin.shopId } });
  if (!shop) {
    return [];
  }
  await ensureAdminShopLink(adminId, shop.id);
  return [shop];
}

/**
 * Backend authorization (Phase 1 spec §6): verifies the authenticated
 * admin actually owns `shopId` before any handler acts on it. Never trust
 * a frontend-supplied shopId — this is the one place that check happens.
 */
export async function assertAdminOwnsShop(adminId: string, shopId: string): Promise<Shop> {
  const link = await prisma.adminShopLink.findUnique({
    where: { adminId_shopId: { adminId, shopId } },
  });
  if (link) {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) throw Errors.notFound("Shop not found.", "SHOP_NOT_FOUND");
    return shop;
  }

  // Legacy fallback + self-heal: an admin created before AdminShopLink
  // existed is still authorized for the one shop already on their account.
  const admin = await prisma.user.findUnique({ where: { id: adminId } });
  if (admin?.shopId === shopId) {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) throw Errors.notFound("Shop not found.", "SHOP_NOT_FOUND");
    await ensureAdminShopLink(adminId, shopId);
    return shop;
  }

  throw Errors.forbidden("You don't have access to that shop.", "SHOP_ACCESS_DENIED");
}
