import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { centralAdminOnly } from "../../lib/centralAdmin.js";
import { NOTIFICATION_DEFAULTS } from "../../notifications/constants.js";
import { toNumber } from "../../lib/money.js";

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24h, IST)");
const settingsBody = z
  .object({
    openingTime: hhmm.nullable(),
    closingTime: hhmm.nullable(),
    highValueSaleThreshold: z.number().positive().max(100_000_000).nullable(),
    largeCreditThreshold: z.number().positive().max(100_000_000).nullable(),
    creditOverdueDays: z.number().int().min(1).max(3650).nullable(),
  })
  .partial()
  .strict();
const shopParams = z.object({ shopId: z.string().min(1).max(64) });
const productParams = shopParams.extend({ productId: z.string().min(1).max(64) });
const thresholdBody = z.object({ lowStockThreshold: z.number().int().min(0).max(1_000_000).nullable() }).strict();

const LIMIT = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/**
 * Branch-level notification configuration (D-17 low-stock overrides, D-18
 * opening/closing times, D-19 threshold overrides, credit rule). `null` =
 * "use the global default". Central Admin only; the branch is addressed by a
 * path id that is checked to exist — it is never used to widen access.
 */
export default async function branchNotificationSettingsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  fastify.addHook("preHandler", centralAdminOnly("manage branch notification settings"));

  async function assertShop(shopId: string) {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, name: true } });
    if (!shop) throw Errors.notFound("Branch not found.", "SHOP_NOT_FOUND");
    return shop;
  }

  const view = async (shopId: string) => {
    const row = await prisma.branchNotificationSettings.findUnique({ where: { shopId } });
    return {
      shopId,
      openingTime: row?.openingTime ?? null,
      closingTime: row?.closingTime ?? null,
      highValueSaleThreshold: row?.highValueSaleThreshold ? toNumber(row.highValueSaleThreshold) : null,
      largeCreditThreshold: row?.largeCreditThreshold ? toNumber(row.largeCreditThreshold) : null,
      creditOverdueDays: row?.creditOverdueDays ?? null,
      defaults: {
        highValueSaleThreshold: NOTIFICATION_DEFAULTS.highValueSaleThreshold,
        largeCreditThreshold: NOTIFICATION_DEFAULTS.largeCreditThreshold,
        creditOverdueDays: NOTIFICATION_DEFAULTS.creditOverdueDays,
      },
    };
  };

  fastify.get("/:shopId", { config: LIMIT }, async (request) => {
    const { shopId } = parseBody(shopParams, request.params);
    await assertShop(shopId);
    return view(shopId);
  });

  fastify.put("/:shopId", { config: LIMIT }, async (request) => {
    const { shopId } = parseBody(shopParams, request.params);
    const body = parseBody(settingsBody, request.body);
    await assertShop(shopId);
    await prisma.branchNotificationSettings.upsert({
      where: { shopId },
      create: { shopId, ...body, updatedById: request.authUser!.id },
      update: { ...body, updatedById: request.authUser!.id },
    });
    return view(shopId);
  });

  // D-17: per-branch override of a product's low-stock level; null removes it (global fallback).
  fastify.put("/:shopId/products/:productId/low-stock-threshold", { config: LIMIT }, async (request) => {
    const { shopId, productId } = parseBody(productParams, request.params);
    const { lowStockThreshold } = parseBody(thresholdBody, request.body);
    await assertShop(shopId);
    const assigned = await prisma.branchProduct.findFirst({ where: { shopId, productId, isAssigned: true }, select: { id: true } });
    if (!assigned) throw Errors.notFound("That product is not assigned to this branch.", "PRODUCT_NOT_FOUND");
    if (lowStockThreshold === null) {
      await prisma.branchProductLowStock.deleteMany({ where: { shopId, productId } });
    } else {
      await prisma.branchProductLowStock.upsert({
        where: { shopId_productId: { shopId, productId } },
        create: { shopId, productId, lowStockThreshold },
        update: { lowStockThreshold },
      });
    }
    return { shopId, productId, lowStockThreshold };
  });
}
