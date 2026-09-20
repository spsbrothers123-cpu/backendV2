import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import {
  generateInvitationCode,
  hashInvitationCode,
  invitationCodeExpiryDate,
} from "../../lib/invitationCode.js";
import { Errors } from "../../lib/errors.js";
import { recordAudit } from "../../lib/audit.js";

// Cap on regeneration attempts if a freshly-generated code happens to
// collide (by hash) with another admin's currently-ACTIVE code. With only
// 1,000,000 possible 6-digit codes and typically a handful of ACTIVE codes
// system-wide at once, this is astronomically unlikely to ever loop more
// than once — it exists purely so validate-by-hash-lookup (routes/auth.ts)
// can never accidentally match the wrong code.
const MAX_GENERATION_ATTEMPTS = 5;

// RBR Egg Mart V2 Phase 1: an invitation code is generic — "authorized to
// register as an Egg Mart cashier" — and is NOT tied to any shop. It must
// never be generated from, filtered by, or displayed with the Admin app's
// Global Shop Selector (whichever shop happens to be currently active).
// The shop a cashier ends up in is decided later, at signup, from the
// Branch Name they themselves type in (see src/lib/shopAccess.ts
// resolveOrCreateShopByLocation and src/routes/auth.ts POST /signup).
//
// A code is scoped to the admin who created it (createdByAdminId) — that
// admin owns/manages it (can see it, regenerate it, revoke it) regardless
// of which shop they currently have selected or how many shops they own.
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
  // Generates a new, generic invitation code for the requesting admin,
  // revoking any existing ACTIVE code of theirs first — an admin only ever
  // has one live code at a time (Backend spec §5, reinterpreted as
  // per-admin rather than per-shop for Phase 1). Rate limited to slow down
  // abuse/enumeration. Takes no body: there is no shop to target.
  fastify.post(
    "/",
    { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const admin = request.authUser!;

      const invitation = await prisma.$transaction(async (tx) => {
        await tx.invitationCode.updateMany({
          where: { createdByAdminId: admin.id, status: "ACTIVE" },
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
        entityType: "InvitationCode",
        entityId: invitation.id,
      });

      return reply.code(201).send({ success: true, data: toInvitationCodeResponse(invitation), message: "Invitation code generated." });
    }
  );

  // ── GET /api/admin/invitation-codes/active ───────────────────────────
  fastify.get("/active", async (request) => {
    const admin = request.authUser!;

    let invitation = await prisma.invitationCode.findFirst({
      where: { createdByAdminId: admin.id, status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
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

    // A code that doesn't exist, or belongs to a different admin, is
    // reported as "not found" so its existence isn't revealed.
    if (!invitation || invitation.createdByAdminId !== admin.id) {
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
      entityType: "InvitationCode",
      entityId: updated.id,
    });

    return { success: true, data: { id: updated.id, status: updated.status }, message: "Invitation code revoked." };
  });
}
