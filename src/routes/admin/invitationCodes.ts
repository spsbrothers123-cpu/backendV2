import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";
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

function toInvitationCodeResponse(invitation: {
  id: string;
  codePlain: string | null;
  status: string;
  createdAt: Date;
  expiresAt: Date;
}) {
  return {
    id: invitation.id,
    code: invitation.codePlain,
    status: invitation.status,
    createdAt: invitation.createdAt.toISOString(),
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

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
      if (!admin.shopId) {
        throw Errors.forbidden("Your admin account isn't linked to a shop.", "NO_SHOP");
      }

      const invitation = await prisma.$transaction(async (tx) => {
        await tx.invitationCode.updateMany({
          where: { shopId: admin.shopId!, status: "ACTIVE" },
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
          data: {
            shopId: admin.shopId!,
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
        shopId: admin.shopId,
        entityType: "InvitationCode",
        entityId: invitation.id,
      });

      return reply.code(201).send({ success: true, data: toInvitationCodeResponse(invitation), message: "Invitation code generated." });
    }
  );

  // ── GET /api/admin/invitation-codes/active ───────────────────────────
  fastify.get("/active", async (request) => {
    const admin = request.authUser!;
    if (!admin.shopId) {
      return { success: true, data: null, message: "Success" };
    }

    let invitation = await prisma.invitationCode.findFirst({
      where: { shopId: admin.shopId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
    });

    // Lazily flip a stale-but-still-marked-ACTIVE code to EXPIRED so the
    // admin never sees a code that looks live but would fail validation.
    if (invitation && invitation.expiresAt <= new Date()) {
      invitation = await prisma.invitationCode.update({
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

    if (!invitation || invitation.shopId !== admin.shopId) {
      throw Errors.notFound("Invitation code not found.", "INVITATION_CODE_NOT_FOUND");
    }
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
      shopId: admin.shopId,
      entityType: "InvitationCode",
      entityId: updated.id,
    });

    return { success: true, data: { id: updated.id, status: updated.status }, message: "Invitation code revoked." };
  });
}
