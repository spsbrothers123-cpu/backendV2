import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { Shop, UpiCommonAccount, UpiShopAccount } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { assertAdminOwnsShop, listShopsForAdmin } from "../../lib/shopAccess.js";
import {
  maskUpiId,
  normalizePayeeName,
  normalizeUpiId,
  resolveEffectiveReceiver,
  validatePayeeName,
  validateUpiId,
} from "../../lib/upi.js";

// ── Admin UPI Management ────────────────────────────────────────────────
//
// Deliberately independent of the Global Shop Selector (same stance as
// consolidation): nothing in this file reads or writes User.shopId. The
// admin's identity comes ONLY from the verified token, the shops they may
// touch come ONLY from listShopsForAdmin / assertAdminOwnsShop, and every
// row is keyed by that admin's id — one Admin can never read or change
// another Admin's UPI settings, even on a shop they both manage.
//
// Configuration only. Nothing here creates, confirms or verifies a payment.

const accountFields = {
  upiId: z.string(),
  payeeName: z.string(),
  enabled: z.boolean(),
};

const commonSchema = z.object(accountFields);

const shopSchema = z.discriminatedUnion("mode", [
  // COMMON changes only the mode; saved custom details stay dormant.
  z.object({ mode: z.literal("COMMON") }),
  z.object({ mode: z.literal("CUSTOM"), ...accountFields }),
]);

/** Validates + normalizes an account's fields, throwing field-specific codes. */
function checkAccount(input: { upiId: string; payeeName: string }) {
  const idError = validateUpiId(input.upiId);
  if (idError) throw new AppError(422, "UPI_ID_INVALID", idError);
  const nameError = validatePayeeName(input.payeeName);
  if (nameError) throw new AppError(422, "PAYEE_NAME_INVALID", nameError);
  return { upiId: normalizeUpiId(input.upiId), payeeName: normalizePayeeName(input.payeeName) };
}

function toCommonView(row: UpiCommonAccount | null) {
  if (!row) return null;
  return {
    upiId: row.upiId,
    payeeName: row.payeeName,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toBranchView(
  shop: Shop,
  row: UpiShopAccount | null,
  common: UpiCommonAccount | null,
  sharedWithOtherAdmins: boolean
) {
  const hasCustom = row?.customUpiId != null && row.customPayeeName != null;
  return {
    shopId: shop.id,
    shopName: shop.name,
    shopCode: shop.code,
    location: shop.location,
    mode: row?.mode ?? "COMMON",
    // Dormant while mode = COMMON — returned so the form can prefill it,
    // but never used by the resolver in that mode.
    custom: hasCustom
      ? { upiId: row!.customUpiId!, payeeName: row!.customPayeeName!, enabled: row!.customEnabled }
      : null,
    effective: resolveEffectiveReceiver(
      common ? { upiId: common.upiId, payeeName: common.payeeName, enabled: common.enabled } : null,
      row
        ? {
            mode: row.mode,
            customUpiId: row.customUpiId,
            customPayeeName: row.customPayeeName,
            customEnabled: row.customEnabled,
          }
        : null
    ),
    sharedWithOtherAdmins,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

/** Two concurrent first-time saves can both miss the row and both try to
 * create it; the unique key makes the loser fail with P2002. Retry once —
 * the second attempt then takes the update path. */
async function withUpsertRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return fn();
    }
    throw err;
  }
}

export default async function adminUpiRoutes(fastify: FastifyInstance) {
  // Authentication + ADMIN role on every route. Cashiers get 403.
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/upi/overview ──────────────────────────────────────
  fastify.get("/overview", async (request) => {
    const admin = request.authUser!;
    const shops = await listShopsForAdmin(admin.id);
    const shopIds = shops.map((s) => s.id);

    const [common, rows, otherLinks] = await Promise.all([
      prisma.upiCommonAccount.findUnique({ where: { adminId: admin.id } }),
      prisma.upiShopAccount.findMany({ where: { adminId: admin.id, shopId: { in: shopIds } } }),
      // Only a boolean per shop is derived from other admins — never any of
      // their account data.
      prisma.adminShopLink.findMany({
        where: {
          shopId: { in: shopIds },
          adminId: { not: admin.id },
          admin: { role: "ADMIN", status: "ACTIVE" },
        },
        select: { shopId: true },
      }),
    ]);

    const rowByShop = new Map(rows.map((r) => [r.shopId, r]));
    const shared = new Set(otherLinks.map((l) => l.shopId));

    return {
      success: true,
      data: {
        common: toCommonView(common),
        branches: shops.map((s) => toBranchView(s, rowByShop.get(s.id) ?? null, common, shared.has(s.id))),
      },
    };
  });

  // ── PUT /api/admin/upi/common ────────────────────────────────────────
  fastify.put("/common", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(commonSchema, request.body);
    const account = checkAccount(body);

    const saved = await withUpsertRetry(() =>
      prisma.upiCommonAccount.upsert({
        where: { adminId: admin.id },
        create: { adminId: admin.id, ...account, enabled: body.enabled },
        update: { ...account, enabled: body.enabled },
      })
    );

    await recordAudit({
      action: "UPI_CONFIG_UPDATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      entityType: "UpiCommonAccount",
      entityId: saved.id,
      metadata: { scope: "COMMON", enabled: saved.enabled, upiId: maskUpiId(saved.upiId) },
    });

    return { success: true, data: { common: toCommonView(saved) }, message: "UPI account saved." };
  });

  // ── PUT /api/admin/upi/shops/:shopId ─────────────────────────────────
  fastify.put<{ Params: { shopId: string } }>("/shops/:shopId", async (request) => {
    const admin = request.authUser!;

    // Authorization first, from the verified admin identity — the shopId in
    // the URL is only ever a candidate that must be one of this admin's own.
    const shop = await assertAdminOwnsShop(admin.id, request.params.shopId);

    const body = parseBody(shopSchema, request.body);

    let saved: UpiShopAccount;
    if (body.mode === "COMMON") {
      saved = await withUpsertRetry(() =>
        prisma.upiShopAccount.upsert({
          where: { adminId_shopId: { adminId: admin.id, shopId: shop.id } },
          create: { adminId: admin.id, shopId: shop.id, mode: "COMMON" },
          // Only the mode changes: saved custom details stay untouched.
          update: { mode: "COMMON" },
        })
      );
    } else {
      const account = checkAccount(body);
      saved = await withUpsertRetry(() =>
        prisma.upiShopAccount.upsert({
          where: { adminId_shopId: { adminId: admin.id, shopId: shop.id } },
          create: {
            adminId: admin.id,
            shopId: shop.id,
            mode: "CUSTOM",
            customUpiId: account.upiId,
            customPayeeName: account.payeeName,
            customEnabled: body.enabled,
          },
          update: {
            mode: "CUSTOM",
            customUpiId: account.upiId,
            customPayeeName: account.payeeName,
            customEnabled: body.enabled,
          },
        })
      );
    }

    const common = await prisma.upiCommonAccount.findUnique({ where: { adminId: admin.id } });
    const otherAdmins = await prisma.adminShopLink.count({
      where: { shopId: shop.id, adminId: { not: admin.id }, admin: { role: "ADMIN", status: "ACTIVE" } },
    });

    await recordAudit({
      action: "UPI_CONFIG_UPDATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: shop.id,
      entityType: "UpiShopAccount",
      entityId: saved.id,
      metadata: {
        scope: "SHOP",
        mode: saved.mode,
        ...(body.mode === "CUSTOM"
          ? { enabled: saved.customEnabled, upiId: maskUpiId(saved.customUpiId ?? "") }
          : {}),
      },
    });

    return {
      success: true,
      data: { branch: toBranchView(shop, saved, common, otherAdmins > 0) },
      message: "Shop UPI settings saved.",
    };
  });
}
