import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { getOrCreateShopSettings } from "../../lib/shopSettings.js";
import {
  toShopSettings,
  toTaxBillingSettings,
  toAppearanceSettings,
  toPosSettings,
  toSecuritySettings,
} from "../../lib/serializeAdmin.js";

const shopSchema = z.object({
  shopName: z.string().trim().min(1, "Shop name is required.").max(150),
  address: z.string().trim().max(300).optional().default(""),
  gstin: z.string().trim().max(20).optional().default(""),
  phone: z.string().trim().max(20).optional().default(""),
  email: z.string().trim().max(150).optional().default(""),
});

const taxBillingSchema = z.object({
  gstEnabled: z.boolean(),
  gstPercentage: z.coerce.number().min(0).max(100),
  invoicePrefix: z.string().trim().max(20),
  invoiceFooterNote: z.string().trim().max(500),
});

const appearanceSchema = z.object({
  theme: z.enum(["light", "dark", "system"]),
  productDisplay: z.enum(["grid", "list"]),
});

const posSchema = z.object({
  receiptFooter: z.string().trim().max(500),
  printerName: z.string().trim().max(150),
  autoPrintReceipt: z.boolean(),
  invoiceFormat: z.enum(["A4", "Thermal 80mm", "Thermal 58mm"]),
});

const securitySchema = z.object({
  sessionTimeoutMinutes: z.coerce.number().int().min(1).max(1440),
  requireConfirmationForRefunds: z.boolean(),
});

export default async function adminSettingsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  async function logSettingsUpdate(shopId: string | null, actorId: string, section: string) {
    await recordAudit({
      action: "SETTINGS_UPDATED",
      actorId,
      actorRole: "ADMIN",
      shopId,
      entityType: "ShopSettings",
      entityId: shopId ?? undefined,
      metadata: { section },
    });
  }

  // ── /api/admin/settings/shop ──────────────────────────────────────────
  fastify.get("/shop", async (request) => {
    const admin = request.authUser!;
    const [shop, settings] = await Promise.all([
      prisma.shop.findUniqueOrThrow({ where: { id: admin.shopId! } }),
      getOrCreateShopSettings(admin.shopId!),
    ]);
    return toShopSettings(shop, settings);
  });

  fastify.put("/shop", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(shopSchema, request.body);

    const [shop, settings] = await Promise.all([
      prisma.shop.update({ where: { id: admin.shopId! }, data: { name: body.shopName, address: body.address } }),
      prisma.shopSettings.upsert({
        where: { shopId: admin.shopId! },
        update: { gstin: body.gstin, contactPhone: body.phone, contactEmail: body.email },
        create: { shopId: admin.shopId!, gstin: body.gstin, contactPhone: body.phone, contactEmail: body.email },
      }),
    ]);

    await logSettingsUpdate(admin.shopId, admin.id, "shop");
    return toShopSettings(shop, settings);
  });

  // ── /api/admin/settings/tax-billing ──────────────────────────────────
  fastify.get("/tax-billing", async (request) => {
    const admin = request.authUser!;
    const settings = await getOrCreateShopSettings(admin.shopId!);
    return toTaxBillingSettings(settings);
  });

  fastify.put("/tax-billing", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(taxBillingSchema, request.body);
    const updated = await prisma.shopSettings.upsert({
      where: { shopId: admin.shopId! },
      update: { taxBilling: body },
      create: { shopId: admin.shopId!, taxBilling: body },
    });
    await logSettingsUpdate(admin.shopId, admin.id, "tax-billing");
    return toTaxBillingSettings(updated);
  });

  // ── /api/admin/settings/appearance ────────────────────────────────────
  fastify.get("/appearance", async (request) => {
    const admin = request.authUser!;
    const settings = await getOrCreateShopSettings(admin.shopId!);
    return toAppearanceSettings(settings);
  });

  fastify.put("/appearance", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(appearanceSchema, request.body);
    const updated = await prisma.shopSettings.upsert({
      where: { shopId: admin.shopId! },
      update: { appearance: body },
      create: { shopId: admin.shopId!, appearance: body },
    });
    await logSettingsUpdate(admin.shopId, admin.id, "appearance");
    return toAppearanceSettings(updated);
  });

  // ── /api/admin/settings/pos ────────────────────────────────────────────
  fastify.get("/pos", async (request) => {
    const admin = request.authUser!;
    const settings = await getOrCreateShopSettings(admin.shopId!);
    return toPosSettings(settings);
  });

  fastify.put("/pos", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(posSchema, request.body);
    const updated = await prisma.shopSettings.upsert({
      where: { shopId: admin.shopId! },
      update: { pos: body },
      create: { shopId: admin.shopId!, pos: body },
    });
    await logSettingsUpdate(admin.shopId, admin.id, "pos");
    return toPosSettings(updated);
  });

  // ── /api/admin/settings/security ──────────────────────────────────────
  fastify.get("/security", async (request) => {
    const admin = request.authUser!;
    const settings = await getOrCreateShopSettings(admin.shopId!);
    return toSecuritySettings(settings);
  });

  fastify.put("/security", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(securitySchema, request.body);
    const updated = await prisma.shopSettings.upsert({
      where: { shopId: admin.shopId! },
      update: { security: body },
      create: { shopId: admin.shopId!, security: body },
    });
    await logSettingsUpdate(admin.shopId, admin.id, "security");
    return toSecuritySettings(updated);
  });
}
