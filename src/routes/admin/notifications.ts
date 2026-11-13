import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { centralAdminOnly } from "../../lib/centralAdmin.js";
import { istDateRange, isValidDateString } from "../../lib/ist.js";
import { categoryFromSlug } from "../../notifications/constants.js";
import {
  clearRead,
  countUnread,
  deleteOwned,
  getOwned,
  listPage,
  markAllRead,
  setReadState,
} from "../../notifications/inbox.js";
import { toAdminNotificationItem } from "../../notifications/serializers.js";

const dateStr = z.string().refine(isValidDateString, "must be a date as YYYY-MM-DD");

const listQuery = z.object({
  status: z.enum(["unread", "read"]).optional(),
  category: z.string().trim().min(1).max(40).optional(),
  // A FILTER only — never an access restriction (central Admin sees every branch).
  branchId: z.string().trim().min(1).max(64).optional(),
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const readBody = z.object({ read: z.boolean().default(true) }).default({});
const idParams = z.object({ id: z.string().min(1).max(64) });

const READ_LIMIT = { rateLimit: { max: 120, timeWindow: "1 minute" } };
const WRITE_LIMIT = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/**
 * D-01/D-02: existing Admin paths and verbs are preserved. Central Admin only
 * (CENTRAL_ADMIN_USER_ID); the recipient is always the authenticated user, and
 * no shop/user id is ever read from the client.
 */
export default async function adminNotificationsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  fastify.addHook("preHandler", centralAdminOnly("view notifications"));

  // GET /api/admin/notifications
  fastify.get("/", { config: READ_LIMIT }, async (request) => {
    const userId = request.authUser!.id;
    const q = parseBody(listQuery, request.query);

    let category;
    if (q.category) {
      category = categoryFromSlug("ADMIN", q.category);
      // Unknown categories are tolerated (contract): they simply match nothing.
      if (!category) return { items: [], total: 0, page: q.page, pageSize: q.pageSize, unreadCount: await countUnread(userId) };
    }
    if (q.dateFrom && q.dateTo && q.dateFrom > q.dateTo) throw Errors.validation("dateFrom must not be after dateTo.");

    const { rows, total, unreadCount } = await listPage(
      userId,
      { status: q.status, category, shopId: q.branchId, range: istDateRange(q.dateFrom, q.dateTo) },
      q.page,
      q.pageSize
    );
    return { items: rows.map(toAdminNotificationItem), total, page: q.page, pageSize: q.pageSize, unreadCount };
  });

  // GET /api/admin/notifications/unread-count   (D-12)
  fastify.get("/unread-count", { config: READ_LIMIT }, async (request) => ({
    unreadCount: await countUnread(request.authUser!.id),
  }));

  // PATCH /api/admin/notifications/read-all
  fastify.patch("/read-all", { config: WRITE_LIMIT }, async (request, reply) => {
    await markAllRead(request.authUser!.id);
    return reply.code(204).send();
  });

  // POST /api/admin/notifications/clear-read
  fastify.post("/clear-read", { config: WRITE_LIMIT }, async (request) => ({
    deletedCount: await clearRead(request.authUser!.id),
  }));

  // GET /api/admin/notifications/:id   (D-12)
  fastify.get("/:id", { config: READ_LIMIT }, async (request) => {
    const { id } = parseBody(idParams, request.params);
    return toAdminNotificationItem(await getOwned(request.authUser!.id, id));
  });

  // PATCH /api/admin/notifications/:id/read   body { read: true | false }
  fastify.patch("/:id/read", { config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = parseBody(idParams, request.params);
    const { read } = parseBody(readBody, request.body ?? {});
    await setReadState(request.authUser!.id, id, read);
    return reply.code(204).send();
  });

  // DELETE /api/admin/notifications/:id
  fastify.delete("/:id", { config: WRITE_LIMIT }, async (request, reply) => {
    const { id } = parseBody(idParams, request.params);
    await deleteOwned(request.authUser!.id, id);
    return reply.code(204).send();
  });
}
