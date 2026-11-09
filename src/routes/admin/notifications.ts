import type { FastifyInstance } from "fastify";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { toAdminNotification } from "../../lib/serializeAdmin.js";

export default async function adminNotificationsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/notifications ─────────────────────────────────────
  fastify.get("/", async (request) => {
    const admin = request.authUser!;
    const notifications = await prisma.notification.findMany({
      where: { shopId: admin.shopId! },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return notifications.map(toAdminNotification);
  });

  // ── PATCH /api/admin/notifications/:id/read ──────────────────────────
  fastify.patch<{ Params: { id: string } }>("/:id/read", async (request, reply) => {
    const admin = request.authUser!;
    const existing = await prisma.notification.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Notification not found.", "NOTIFICATION_NOT_FOUND");
    }
    await prisma.notification.update({ where: { id: existing.id }, data: { read: true } });
    return reply.code(204).send();
  });

  // ── PATCH /api/admin/notifications/read-all ──────────────────────────
  fastify.patch("/read-all", async (request, reply) => {
    const admin = request.authUser!;
    await prisma.notification.updateMany({
      where: { shopId: admin.shopId!, read: false },
      data: { read: true },
    });
    return reply.code(204).send();
  });
}
