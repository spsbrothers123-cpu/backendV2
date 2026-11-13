import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../lib/errors.js";
import { parseBody } from "../lib/validate.js";
import { mergeRanges, parseBound } from "../lib/ist.js";
import { categoryFromSlug } from "../notifications/constants.js";
import { acknowledge, countUnread, deleteOwned, getOwned, listCursor, setReadState } from "../notifications/inbox.js";
import { applyPreferenceChanges, getPreferenceViews } from "../notifications/preferences.js";
import { toCashierNotificationItem } from "../notifications/serializers.js";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).max(512).optional(),
  status: z.enum(["all", "unread"]).default("all"),
  category: z.string().trim().min(1).max(40).optional(),
  from: z.string().trim().min(1).max(40).optional(),
  to: z.string().trim().min(1).max(40).optional(),
});
const idParams = z.object({ id: z.string().min(1).max(64) });
const readStateBody = z.object({ read: z.boolean() });
const settingsBody = z.object({ categories: z.record(z.string().min(1).max(40), z.boolean()) });
const ackHeaders = z.object({ "idempotency-key": z.string().min(8).max(128).optional() });

const READ_LIMIT = { rateLimit: { max: 120, timeWindow: "1 minute" } };
const WRITE_LIMIT = { rateLimit: { max: 60, timeWindow: "1 minute" } };

/**
 * Cashier notifications (CASHIER_NOTIFICATIONS_API_CONTRACT.md). Scope — the
 * Cashier and therefore the branch — comes ONLY from the verified token; the
 * client never sends a cashier or shop id, and foreign ids answer 404.
 */
export default async function cashierNotificationsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("CASHIER"));

  const unread = (userId: string) => countUnread(userId);

  // GET /api/notifications
  fastify.get("/", { config: READ_LIMIT }, async (request) => {
    const userId = request.authUser!.id;
    const q = parseBody(listQuery, request.query);
    let category;
    if (q.category) {
      category = categoryFromSlug("CASHIER", q.category);
      if (!category) return { items: [], nextCursor: null, unreadCount: await unread(userId) };
    }
    let range;
    try {
      range = mergeRanges(parseBound(q.from, "from"), parseBound(q.to, "to"));
    } catch {
      throw Errors.validation("from/to must be a YYYY-MM-DD date or an ISO date-time.");
    }
    const { rows, nextCursor, unreadCount } = await listCursor(userId, { status: q.status, category, range }, q.limit, q.cursor);
    return { items: rows.map(toCashierNotificationItem), nextCursor, unreadCount };
  });

  // GET /api/notifications/unread-count   (D-12)
  fastify.get("/unread-count", { config: READ_LIMIT }, async (request) => ({ unreadCount: await unread(request.authUser!.id) }));

  // GET|PATCH /api/notifications/settings   (D-27) — registered before /:id; static paths win anyway.
  fastify.get("/settings", { config: READ_LIMIT }, async (request) => ({
    categories: await getPreferenceViews(request.authUser!.id, "CASHIER"),
  }));
  fastify.patch("/settings", { config: WRITE_LIMIT }, async (request) => {
    const userId = request.authUser!.id;
    const body = parseBody(settingsBody, request.body);
    await applyPreferenceChanges(
      userId,
      "CASHIER",
      Object.entries(body.categories).map(([slug, enabled]) => ({ slug, enabled })),
      "reject" // contract: 403 SETTING_NOT_MUTABLE
    );
    return { categories: await getPreferenceViews(userId, "CASHIER") };
  });

  // GET /api/notifications/:id   (D-12)
  fastify.get("/:id", { config: READ_LIMIT }, async (request) => {
    const { id } = parseBody(idParams, request.params);
    return toCashierNotificationItem(await getOwned(request.authUser!.id, id));
  });

  // PUT /api/notifications/:id/read-state
  fastify.put("/:id/read-state", { config: WRITE_LIMIT }, async (request) => {
    const userId = request.authUser!.id;
    const { id } = parseBody(idParams, request.params);
    const { read } = parseBody(readStateBody, request.body);
    const row = await setReadState(userId, id, read);
    return { notification: toCashierNotificationItem(row), unreadCount: await unread(userId) };
  });

  // DELETE /api/notifications/:id
  fastify.delete("/:id", { config: WRITE_LIMIT }, async (request) => {
    const userId = request.authUser!.id;
    const { id } = parseBody(idParams, request.params);
    await deleteOwned(userId, id);
    return { id, unreadCount: await unread(userId) };
  });

  // POST /api/notifications/:id/acknowledge
  fastify.post("/:id/acknowledge", { config: WRITE_LIMIT }, async (request) => {
    const userId = request.authUser!.id;
    const { id } = parseBody(idParams, request.params);
    // Optional, validated for shape only: idempotency is enforced by the
    // database state itself (a repeat returns the ORIGINAL acknowledgedAt).
    parseBody(ackHeaders, { "idempotency-key": request.headers["idempotency-key"] });
    const row = await acknowledge(userId, id);
    return { notification: toCashierNotificationItem(row), unreadCount: await unread(userId) };
  });
}
