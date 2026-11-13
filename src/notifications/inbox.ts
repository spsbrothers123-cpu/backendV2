/**
 * Per-user notification state + queries, shared by the Admin and Cashier APIs.
 *
 * SECURITY: every query is keyed by the AUTHENTICATED user id (`userId`) taken
 * from the verified token by the route — never from the request. A recipient
 * row that belongs to someone else is indistinguishable from a missing one
 * (404), so ids can't be probed (IDOR).
 */
import type { NtfCategory, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, Errors } from "../lib/errors.js";
import { LOCKED_CATEGORIES } from "./constants.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import type { InstantRange } from "../lib/ist.js";

export const recipientInclude = {
  notification: { include: { shop: { select: { id: true, name: true } }, announcement: true } },
} satisfies Prisma.AppNotificationRecipientInclude;

export type InboxRow = Prisma.AppNotificationRecipientGetPayload<{ include: typeof recipientInclude }>;

export interface InboxFilter {
  status?: "unread" | "read" | "all";
  category?: NtfCategory;
  shopId?: string;
  range?: InstantRange;
}

function liveWhere(userId: string, now: Date): Prisma.AppNotificationRecipientWhereInput {
  return { userId, deletedAt: null, notification: { expiresAt: { gt: now } } };
}

function filterWhere(userId: string, f: InboxFilter, now: Date): Prisma.AppNotificationRecipientWhereInput {
  const and: Prisma.AppNotificationRecipientWhereInput[] = [liveWhere(userId, now)];
  if (f.status === "unread") and.push({ readAt: null });
  if (f.status === "read") and.push({ readAt: { not: null } });
  if (f.category) and.push({ notification: { category: f.category } });
  if (f.shopId) and.push({ notification: { shopId: f.shopId } });
  if (f.range?.gte || f.range?.lt) {
    and.push({ createdAt: { ...(f.range.gte ? { gte: f.range.gte } : {}), ...(f.range.lt ? { lt: f.range.lt } : {}) } });
  }
  return { AND: and };
}

/** Unread across ALL branches/categories, ignoring any filter or page (drives the badge). */
export async function countUnread(userId: string, now = new Date()): Promise<number> {
  return prisma.appNotificationRecipient.count({ where: { ...liveWhere(userId, now), readAt: null } });
}

const ORDER = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/** Admin: page / pageSize. */
export async function listPage(userId: string, f: InboxFilter, page: number, pageSize: number, now = new Date()) {
  const where = filterWhere(userId, f, now);
  const [total, rows, unreadCount] = await Promise.all([
    prisma.appNotificationRecipient.count({ where }),
    prisma.appNotificationRecipient.findMany({
      where,
      include: recipientInclude,
      orderBy: ORDER,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    countUnread(userId, now),
  ]);
  return { rows, total, unreadCount };
}

export function filterFingerprint(f: InboxFilter): string {
  return [f.status ?? "all", f.category ?? "", f.shopId ?? "", f.range?.gte?.toISOString() ?? "", f.range?.lt?.toISOString() ?? ""].join("|");
}

/** Cashier: opaque cursor over (createdAt desc, id desc). */
export async function listCursor(userId: string, f: InboxFilter, limit: number, cursor: string | undefined, now = new Date()) {
  const fp = filterFingerprint(f);
  const base = filterWhere(userId, f, now);
  let where: Prisma.AppNotificationRecipientWhereInput = base;
  if (cursor) {
    const c = decodeCursor(cursor, fp);
    const t = new Date(c.t);
    where = { AND: [base, { OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: c.i } }] }] };
  }
  const rows = await prisma.appNotificationRecipient.findMany({ where, include: recipientInclude, orderBy: ORDER, take: limit + 1 });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ t: last.createdAt.toISOString(), i: last.id, f: fp }) : null;
  return { rows: items, nextCursor, unreadCount: await countUnread(userId, now) };
}

/** `id` is the NOTIFICATION id; scoped to the caller. 404 if absent, deleted, expired or not theirs. */
export async function getOwned(userId: string, notificationId: string, now = new Date()): Promise<InboxRow> {
  const row = await prisma.appNotificationRecipient.findFirst({
    where: { ...liveWhere(userId, now), notificationId },
    include: recipientInclude,
  });
  if (!row) throw Errors.notFound("Notification not found.", "NOTIFICATION_NOT_FOUND");
  return row;
}

/** D-07 / D-09: security is protected; a pending-acknowledgement announcement can't be deleted. */
export function canDelete(row: InboxRow): boolean {
  if (LOCKED_CATEGORIES.has(row.notification.category)) return false;
  const ann = row.notification.announcement;
  if (ann?.requiresAcknowledgement && !row.acknowledgedAt) return false;
  return true;
}

/** D-04/D-11: idempotent; read state never touches acknowledgement. */
export async function setReadState(userId: string, notificationId: string, read: boolean, now = new Date()): Promise<InboxRow> {
  const row = await getOwned(userId, notificationId, now);
  if (read) {
    await prisma.appNotificationRecipient.updateMany({ where: { id: row.id, readAt: null }, data: { readAt: now } });
  } else {
    await prisma.appNotificationRecipient.updateMany({ where: { id: row.id, readAt: { not: null } }, data: { readAt: null } });
  }
  return getOwned(userId, notificationId, now);
}

export async function markAllRead(userId: string, now = new Date()): Promise<number> {
  const res = await prisma.appNotificationRecipient.updateMany({
    where: { ...liveWhere(userId, now), readAt: null },
    data: { readAt: now },
  });
  return res.count;
}

/**
 * D-08/D-11: acknowledgement only for announcements that require it. The
 * `acknowledgedAt: null` guard makes concurrent/repeated calls race-safe: the
 * first writer wins and every repeat returns the ORIGINAL timestamp. Never
 * touches readAt.
 */
export async function acknowledge(userId: string, notificationId: string, now = new Date()): Promise<InboxRow> {
  const row = await getOwned(userId, notificationId, now);
  if (!row.notification.announcement?.requiresAcknowledgement) {
    throw new AppError(409, "ACKNOWLEDGEMENT_NOT_REQUIRED", "This notification does not need to be acknowledged.");
  }
  if (!row.acknowledgedAt) {
    await prisma.appNotificationRecipient.updateMany({ where: { id: row.id, acknowledgedAt: null }, data: { acknowledgedAt: now } });
  }
  return getOwned(userId, notificationId, now);
}

/**
 * Soft delete (deletion marker). The marker row stays until the notification
 * itself expires (D-10), so a later sweep can never resurrect it.
 */
export async function deleteOwned(userId: string, notificationId: string, now = new Date()): Promise<void> {
  const row = await getOwned(userId, notificationId, now);
  if (!canDelete(row)) {
    throw new AppError(403, "NOTIFICATION_NOT_DELETABLE", "This notification can't be deleted.");
  }
  await prisma.appNotificationRecipient.updateMany({ where: { id: row.id, deletedAt: null }, data: { deletedAt: now } });
}

/** Admin "clear read": deletes read, deletable notifications only. */
export async function clearRead(userId: string, now = new Date()): Promise<number> {
  const res = await prisma.appNotificationRecipient.updateMany({
    where: {
      ...liveWhere(userId, now),
      readAt: { not: null },
      notification: { expiresAt: { gt: now }, category: { notIn: [...LOCKED_CATEGORIES] } },
      OR: [{ notification: { announcementId: null } }, { acknowledgedAt: { not: null } }, { notification: { announcement: { requiresAcknowledgement: false } } }],
    },
    data: { deletedAt: now },
  });
  return res.count;
}
