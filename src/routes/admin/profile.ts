import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminProfile } from "../../lib/serializeAdmin.js";

const profileSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  email: z.string().trim().min(1, "Email is required.").email("Enter a valid email address."),
});

export default async function adminProfileRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/profile ────────────────────────────────────────────
  fastify.get("/", async (request) => {
    const admin = request.authUser!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    return toAdminProfile(user);
  });

  // ── PUT /api/admin/profile ────────────────────────────────────────────
  fastify.put("/", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(profileSchema, request.body);

    if (body.email !== admin.email) {
      const emailTaken = await prisma.user.findUnique({ where: { email: body.email } });
      if (emailTaken && emailTaken.id !== admin.id) {
        throw Errors.conflict("That email is already in use.", "EMAIL_TAKEN");
      }
    }

    const updated = await prisma.user.update({
      where: { id: admin.id },
      data: { name: body.name, email: body.email },
    });

    await recordAudit({
      action: "PROFILE_UPDATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "User",
      entityId: admin.id,
    });

    return toAdminProfile(updated);
  });
}
