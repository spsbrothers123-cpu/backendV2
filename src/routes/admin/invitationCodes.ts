import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { z } from "zod";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { assertAdminOwnsShop } from "../../lib/shopAccess.js";
import {
  generateInvitationCode,
  hashInvitationCode,
  invitationCodeExpiryDate,
} from "../../lib/invitationCode.js";

// Cap on regeneration attempts if a freshly-generated code happens to
// collide (by hash) with another shop's currently-ACTIVE code. With only
// 1,000,000 possible 6-digit codes and typically a handful of ACTIVE codes
// system-wide at once, this is astronomically unlikely to ever loop more
// than once — it exists purely so validate-by-hash-lookup (routes/auth.ts)
// can never accidentally match the wrong shop's code.
const MAX_GENERATION_ATTEMPTS = 5;

// The invitation's shop is what a cashier who signs up with this code will
// be permanently assigned to (see routes/auth.ts /signup), so the response
// always says which shop that is — the Admin UI shows it next to the code so
// an admin can never hand out a code without knowing where it will place
// the new cashier.
function toInvitationCodeResponse(invitation: {
  id: string;
  codePlain: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  shop: { id: string; name: string; location: string | null };
}) {
  return {
    id: invitation.id,
    code: invitation.codePlain,
    status: invitation.status,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
    shop: {
      id: invitation.shop.id,
      name: invitation.shop.name,
      location: invitation.shop.location ?? undefined,
    },
  };
}

// The target shop is explicit on every call. It is NOT taken from
// request.authUser.shopId: that column is the admin's mutable "currently
// active shop" (changed by POST /admin/shops/switch), and the Cashiers page
// is deliberately shop-independent, so an implicit shop here meant a code
// could silently be minted for — or displayed from — a different shop than
// the one the admin was looking at (typically the seeded "Main Branch").
// Ownership of the requested shop is re-verified server-side every time.
const shopTargetSchema = z.object({
  shopId: z.string().trim().min(1, "shopId is required."),
});

export default async function adminInvitationCodesRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── POST /api/admin/invitation-codes ─────────────────────────────────
  // Generates a new invitation code for the admin's own shop, revoking any
  // existing ACTIVE code first — a shop only ever has one live code
  // (Backend spec §5). Rate limited to slow down abuse/enumeration.
  fastify.post(
    "/",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const admin = request.authUser!;
      const body = parseBody(shopTargetSchema, request.body);
      const shop = await assertAdminOwnsShop(admin.id, body.shopId);

      const invitation = await prisma.$transaction(async (tx) => {
        await tx.invitationCode.updateMany({
          where: { shopId: shop.id, status: "ACTIVE" },
          data: { status: "REVOKED", codePlain: null },
        });

        let code = generateInvitationCode();
        let codeHash = hashInvitationCode(code);
        for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
          const collision = await tx.invitationCode.findFirst({ where: { codeHash, status: "ACTIVE" } });
          if (!collision) break;
          code = generateInvitationCode();
          codeHash = hashInvitationCode(code);
        }

        return tx.invitationCode.create({
          include: { shop: true },
          data: {
            shopId: shop.id,
            codeHash,
            codePlain: code,
            status: "ACTIVE",
            expiresAt: invitationCodeExpiryDate(),
            createdByAdminId: admin.id,
          },
        });
      });

      await recordAudit({
        action: "INVITATION_CODE_GENERATED",
        actorId: admin.id,
        actorRole: "ADMIN",
        shopId: shop.id,
        entityType: "InvitationCode",
        entityId: invitation.id,
      });

      return reply.code(201).send({ success: true, data: toInvitationCodeResponse(invitation), message: "Invitation code generated." });
    }
  );

  // ── GET /api/admin/invitation-codes/active ───────────────────────────
  fastify.get("/active", async (request) => {
    const admin = request.authUser!;
    const query = parseBody(shopTargetSchema, request.query);
    const shop = await assertAdminOwnsShop(admin.id, query.shopId);

    let invitation = await prisma.invitationCode.findFirst({
      where: { shopId: shop.id, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      include: { shop: true },
    });

    // Lazily flip a stale-but-still-marked-ACTIVE code to EXPIRED so the
    // admin never sees a code that looks live but would fail validation.
    if (invitation && invitation.expiresAt <= new Date()) {
      await prisma.invitationCode.update({
        where: { id: invitation.id },
        data: { status: "EXPIRED", codePlain: null },
      });
      invitation = null;
    }

    return { success: true, data: invitation ? toInvitationCodeResponse(invitation) : null, message: "Success" };
  });

  // ── POST /api/admin/invitation-codes/:id/revoke ──────────────────────
  fastify.post<{ Params: { id: string } }>("/:id/revoke", async (request) => {
    const admin = request.authUser!;
    const invitation = await prisma.invitationCode.findUnique({ where: { id: request.params.id } });

    // Authorize against every shop this admin owns (not just the currently
    // active one). A code for a shop they don't own is reported as "not
    // found" so its existence isn't revealed.
    if (!invitation) {
      throw Errors.notFound("Invitation code not found.", "INVITATION_CODE_NOT_FOUND");
    }
    await assertAdminOwnsShop(admin.id, invitation.shopId).catch(() => {
      throw Errors.notFound("Invitation code not found.", "INVITATION_CODE_NOT_FOUND");
    });
    if (invitation.status !== "ACTIVE") {
      throw Errors.conflict("Only an active invitation code can be revoked.", "INVITATION_CODE_NOT_ACTIVE");
    }

    const updated = await prisma.invitationCode.update({
      where: { id: invitation.id },
      data: { status: "REVOKED", codePlain: null },
    });

    await recordAudit({
      action: "INVITATION_CODE_REVOKED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: invitation.shopId,
      entityType: "InvitationCode",
      entityId: updated.id,
    });

    return { success: true, data: { id: updated.id, status: updated.status }, message: "Invitation code revoked." };
  });
}
