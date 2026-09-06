import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { assertAdminOwnsShop, listShopsForAdmin } from "../../lib/shopAccess.js";
import type { Shop } from "@prisma/client";

const switchShopSchema = z.object({
  shopId: z.string().trim().min(1, "shopId is required."),
});

function toShopResponse(shop: Shop, currentShopId: string | null) {
  return {
    id: shop.id,
    name: shop.name,
    code: shop.code,
    location: shop.location,
    address: shop.address,
    current: shop.id === currentShopId,
  };
}

// Backend/database foundation only (Phase 1 spec) — no Global Shop
// Selector UI ships against these yet. They exist so Phase 2's UI has a
// secure, ready-made API: list what this admin owns, and switch which one
// is "active" (drives every other admin/* route via request.authUser.shopId).
export default async function adminShopsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/shops — every shop this admin owns ────────────────
  fastify.get("/", async (request) => {
    const admin = request.authUser!;
    const shops = await listShopsForAdmin(admin.id);
    return {
      success: true,
      data: shops.map((s) => toShopResponse(s, admin.shopId)),
      message: "Success",
    };
  });

  // ── POST /api/admin/shops/switch — change the admin's active shop ────
  // Authenticated Admin → requested shopId → ownership check → authorized.
  // Never trusts the shopId beyond checking it against this admin's own
  // AdminShopLink rows (Phase 1 spec §6).
  fastify.post("/switch", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(switchShopSchema, request.body);

    const shop = await assertAdminOwnsShop(admin.id, body.shopId);

    await prisma.user.update({ where: { id: admin.id }, data: { shopId: shop.id } });

    await recordAudit({
      action: "SHOP_SWITCHED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: shop.id,
      entityType: "Shop",
      entityId: shop.id,
    });

    // request.authUser.shopId is re-read from the database on every
    // request (see plugins/auth.ts) — no new token is needed for this to
    // take effect on the admin's very next call.
    return { success: true, data: toShopResponse(shop, shop.id), message: "Switched shop." };
  });
}
