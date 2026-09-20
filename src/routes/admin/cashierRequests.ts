import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { sendCashierApproved, sendCashierRejected } from "../../lib/email.js";
import { listShopsForAdmin, ensureAdminShopLink } from "../../lib/shopAccess.js";
import type { AccountStatus, Prisma } from "@prisma/client";

const listQuerySchema = z.object({
  status: z.enum(["PENDING_ADMIN_APPROVAL", "REJECTED", "ALL"]).optional(),
});

const rejectBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

// There's no separate "username" concept in this backend (cashiers sign up
// with just name/email/password — see routes/auth.ts), but the Admin UI's
// CashierRequest type displays one. We derive a stable, username-shaped
// value from the email's local part rather than adding a real column for
// something that isn't collected anywhere.
function deriveUsername(email: string): string {
  return email.split("@")[0] ?? email;
}

function toSafeRequest(user: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  branchName: string | null;
  status: AccountStatus;
  createdAt: Date;
  shop: { id: string; name: string } | null;
  invitationCodeMasked: string | null;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    branchName: user.branchName,
    username: deriveUsername(user.email),
    invitationCodeMasked: user.invitationCodeMasked,
    shop: user.shop,
    signupDate: user.createdAt,
    status: user.status,
  };
}

// Which cashier requests an admin may see and act on.
//
// RBR Egg Mart V2 Phase 1: an invitation code carries no shop — the shop is
// resolved at signup from the cashier's own Branch Name, which may be a
// brand-new shop this admin has no AdminShopLink to yet. So a request
// belongs to an admin if EITHER:
//   1. the cashier signed up with a code this admin generated
//      (InvitationCode.createdByAdminId), which is the ownership that
//      actually exists at request time, or
//   2. the cashier's shop is one the admin already owns (covers requests
//      created before codes became shop-less, and shops the admin was
//      linked to by other means).
// Approving a request (below) links the admin to the cashier's shop, so
// from then on the cashier also shows up under Cashiers (cashiers.ts),
// which is scoped purely by AdminShopLink.
function ownedByAdmin(adminId: string, shopIds: string[]): Prisma.UserWhereInput {
  return {
    role: "CASHIER",
    OR: [{ shopId: { in: shopIds } }, { invitationCodeUsed: { is: { createdByAdminId: adminId } } }],
  };
}

export default async function cashierRequestsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/cashier-requests ──────────────────────────────────
  fastify.get("/", async (request) => {
    const query = parseBody(listQuerySchema, request.query);
    const admin = request.authUser!;
    const shopIds = (await listShopsForAdmin(admin.id)).map((s) => s.id);

    const statusFilter: AccountStatus[] =
      query.status && query.status !== "ALL" ? [query.status] : ["PENDING_ADMIN_APPROVAL", "REJECTED"];

    const users = await prisma.user.findMany({
      where: {
        ...ownedByAdmin(admin.id, shopIds),
        status: { in: statusFilter },
      },
      include: { shop: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" },
    });

    return { success: true, data: users.map(toSafeRequest), message: "Success" };
  });

  // ── GET /api/admin/cashier-requests/:id ──────────────────────────────
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    const shopIds = (await listShopsForAdmin(admin.id)).map((s) => s.id);
    const user = await prisma.user.findFirst({
      where: { id: request.params.id, ...ownedByAdmin(admin.id, shopIds) },
      include: { shop: { select: { id: true, name: true } } },
    });
    if (!user) {
      throw Errors.notFound("Cashier request not found.", "REQUEST_NOT_FOUND");
    }
    return { success: true, data: toSafeRequest(user), message: "Success" };
  });

  // ── POST /api/admin/cashier-requests/:id/approve ─────────────────────
  // Note: invitation-code validation (routes/auth.ts) already gated who
  // was allowed to submit a signup request at all — admin approval is a
  // second, independent gate on top of that, not a replacement for it
  // (Backend spec §15: "Invitation code only authorizes signup submission;
  // admin approval is still required").
  fastify.post<{ Params: { id: string } }>("/:id/approve", async (request) => {
    const admin = request.authUser!;
    const shopIds = (await listShopsForAdmin(admin.id)).map((s) => s.id);
    const target = await prisma.user.findFirst({
      where: { id: request.params.id, ...ownedByAdmin(admin.id, shopIds) },
    });

    if (!target || !target.shopId) {
      throw Errors.notFound("Cashier request not found.", "REQUEST_NOT_FOUND");
    }
    if (target.status !== "PENDING_ADMIN_APPROVAL") {
      throw Errors.conflict("This request is not awaiting approval.", "REQUEST_NOT_PENDING");
    }

    const shopId = target.shopId;

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: { status: "ACTIVE", approvedAt: new Date(), approvedBy: admin.id },
    });

    // Approval is the moment the admin takes ownership of the cashier's
    // shop: a cashier whose Branch Name created a brand-new shop would
    // otherwise be approved but never appear under Cashiers, because that
    // page is scoped by AdminShopLink. Deliberately NOT done at signup, so
    // an unapproved (or rejected) request can't add a shop to an admin's
    // account.
    const { linked } = await ensureAdminShopLink(admin.id, shopId);

    await recordAudit({
      action: "CASHIER_APPROVED",
      actorId: admin.id,
      actorRole: "ADMIN",
      // The cashier's OWN shop, not admin.shopId — this admin may be
      // approving a request for a shop they don't currently have selected.
      shopId,
      entityType: "User",
      entityId: target.id,
    });

    if (linked) {
      await recordAudit({
        action: "SHOP_LINKED",
        actorId: admin.id,
        actorRole: "ADMIN",
        shopId,
        entityType: "Shop",
        entityId: shopId,
      });
    }

    await sendCashierApproved(updated.email, updated.name);

    return { success: true, data: { id: updated.id, status: updated.status }, message: "Cashier approved." };
  });

  // ── POST /api/admin/cashier-requests/:id/reject ──────────────────────
  fastify.post<{ Params: { id: string } }>("/:id/reject", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(rejectBodySchema, request.body ?? {});
    const shopIds = (await listShopsForAdmin(admin.id)).map((s) => s.id);

    const target = await prisma.user.findFirst({
      where: { id: request.params.id, ...ownedByAdmin(admin.id, shopIds) },
    });
    if (!target || !target.shopId) {
      throw Errors.notFound("Cashier request not found.", "REQUEST_NOT_FOUND");
    }
    if (target.status !== "PENDING_ADMIN_APPROVAL") {
      throw Errors.conflict("This request can no longer be rejected.", "REQUEST_NOT_PENDING");
    }

    const updated = await prisma.user.update({
      where: { id: target.id },
      data: {
        status: "REJECTED",
        rejectedAt: new Date(),
        rejectedBy: admin.id,
        rejectionReason: body.reason,
      },
    });

    await recordAudit({
      action: "CASHIER_REJECTED",
      actorId: admin.id,
      actorRole: "ADMIN",
      // The cashier's OWN shop, not admin.shopId — same reasoning as approve.
      shopId: target.shopId,
      entityType: "User",
      entityId: target.id,
      metadata: body.reason ? { reason: body.reason } : undefined,
    });

    await sendCashierRejected(updated.email, updated.name, body.reason);

    return { success: true, data: { id: updated.id, status: updated.status }, message: "Cashier request rejected." };
  });
}
