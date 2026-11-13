import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { centralAdminOnly } from "../../lib/centralAdmin.js";
import { createAnnouncement } from "../../notifications/announcements.js";

const composeBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
  audience: z.enum(["all", "individual"]),
  cashierId: z.string().uuid().optional(),
  requiresAcknowledgement: z.boolean().default(false),
});
const reviseBody = composeBody.partial({ audience: true });
const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const WRITE = { rateLimit: { max: 20, timeWindow: "1 minute" } };
const READ = { rateLimit: { max: 120, timeWindow: "1 minute" } };

async function stats(announcementId: string) {
  const notification = await prisma.appNotification.findFirst({
    where: { announcementId },
    select: { id: true },
  });
  if (!notification) return { recipients: 0, read: 0, acknowledged: 0, pendingAcknowledgement: [] as { cashierId: string; name: string; branch: string | null }[] };
  const rows = await prisma.appNotificationRecipient.findMany({
    where: { notificationId: notification.id },
    select: { readAt: true, acknowledgedAt: true, deletedAt: true, user: { select: { id: true, name: true, shop: { select: { name: true } } } } },
  });
  return {
    recipients: rows.length,
    read: rows.filter((r) => r.readAt).length,
    acknowledged: rows.filter((r) => r.acknowledgedAt).length,
    pendingAcknowledgement: rows
      .filter((r) => !r.acknowledgedAt)
      .map((r) => ({ cashierId: r.user.id, name: r.user.name, branch: r.user.shop?.name ?? null })),
  };
}

const present = (a: {
  id: string; title: string; body: string; audience: string; targetCashierId: string | null; requiresAcknowledgement: boolean;
  createdAt: Date; supersedesId: string | null; supersededAt: Date | null;
}) => ({
  id: a.id,
  title: a.title,
  body: a.body,
  audience: a.audience === "INDIVIDUAL" ? "individual" : "all",
  cashierId: a.targetCashierId,
  requiresAcknowledgement: a.requiresAcknowledgement,
  createdAt: a.createdAt.toISOString(),
  revisionOf: a.supersedesId,
  supersededAt: a.supersededAt ? a.supersededAt.toISOString() : null,
});

/**
 * D-21 announcement composer API — Central Admin only. There is deliberately
 * NO update/delete route: published content is immutable (also enforced by a
 * database trigger). A correction is POST /:id/revise, which publishes a new
 * announcement and marks the old one superseded.
 */
export default async function adminAnnouncementsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  fastify.addHook("preHandler", centralAdminOnly("manage announcements"));

  fastify.post("/", { config: WRITE }, async (request, reply) => {
    const b = parseBody(composeBody, request.body);
    const a = await createAnnouncement({
      adminId: request.authUser!.id,
      title: b.title,
      body: b.body,
      audience: b.audience === "individual" ? "INDIVIDUAL" : "ALL_CASHIERS",
      targetCashierId: b.cashierId ?? null,
      requiresAcknowledgement: b.requiresAcknowledgement,
    });
    return reply.code(201).send({ ...present(a), ...(await stats(a.id)) });
  });

  fastify.get("/", { config: READ }, async (request) => {
    const q = parseBody(listQuery, request.query);
    const [total, rows] = await Promise.all([
      prisma.announcement.count(),
      prisma.announcement.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const items = await Promise.all(rows.map(async (a) => {
      const s = await stats(a.id);
      return { ...present(a), recipients: s.recipients, read: s.read, acknowledged: s.acknowledged };
    }));
    return { items, total, page: q.page, pageSize: q.pageSize };
  });

  fastify.get("/:id", { config: READ }, async (request) => {
    const { id } = parseBody(idParams, request.params);
    const a = await prisma.announcement.findUnique({ where: { id } });
    if (!a) throw Errors.notFound("Announcement not found.", "ANNOUNCEMENT_NOT_FOUND");
    return { ...present(a), ...(await stats(a.id)) };
  });

  // Correction = a NEW announcement (or tracked revision) — never an in-place edit.
  fastify.post("/:id/revise", { config: WRITE }, async (request, reply) => {
    const { id } = parseBody(idParams, request.params);
    const b = parseBody(reviseBody, request.body);
    const original = await prisma.announcement.findUnique({ where: { id } });
    if (!original) throw Errors.notFound("Announcement not found.", "ANNOUNCEMENT_NOT_FOUND");
    const audience = b.audience ? (b.audience === "individual" ? "INDIVIDUAL" : "ALL_CASHIERS") : original.audience;
    const a = await createAnnouncement({
      adminId: request.authUser!.id,
      title: b.title,
      body: b.body,
      audience,
      targetCashierId: audience === "INDIVIDUAL" ? (b.cashierId ?? original.targetCashierId) : null,
      requiresAcknowledgement: b.requiresAcknowledgement,
      supersedesId: original.id,
    });
    return reply.code(201).send({ ...present(a), ...(await stats(a.id)) });
  });
}

