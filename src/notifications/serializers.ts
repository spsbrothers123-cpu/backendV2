import { ADMIN_CATEGORY_SLUG, CASHIER_CATEGORY_SLUG, cashierApiType } from "./constants.js";
import { canDelete, type InboxRow } from "./inbox.js";

const sev = (s: string) => s.toLowerCase();

/** Admin frontend contract (NOTIFICATIONS_API_CONTRACT.md). `read` is DERIVED from `readAt` (D-04). */
export function toAdminNotificationItem(row: InboxRow): Record<string, unknown> {
  const n = row.notification;
  return {
    id: n.id,
    category: ADMIN_CATEGORY_SLUG[n.category] ?? n.category.toLowerCase(),
    type: n.type,
    severity: sev(n.severity),
    title: n.title,
    message: n.message,
    createdAt: n.createdAt.toISOString(),
    // legacy field name of the old prototype endpoint — kept so older clients keep parsing
    time: n.createdAt.toISOString(),
    read: row.readAt !== null,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    branch: n.shop ? { id: n.shop.id, name: n.shop.name } : null,
    target: n.targetKind ? { kind: n.targetKind, id: n.targetId ?? null, route: n.targetRoute ?? null } : null,
  };
}

/** Cashier frontend contract (CASHIER_NOTIFICATIONS_API_CONTRACT.md §8). */
export function toCashierNotificationItem(row: InboxRow): Record<string, unknown> {
  const n = row.notification;
  const ann = n.announcement;
  return {
    id: n.id,
    category: CASHIER_CATEGORY_SLUG[n.category] ?? n.category.toLowerCase(),
    type: cashierApiType(n.type),
    severity: sev(n.severity),
    title: n.title,
    message: n.message,
    createdAt: n.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
    recipientCashierId: row.userId,
    shopId: n.shopId,
    capabilities: { canDelete: canDelete(row) },
    target: n.targetKind ? { kind: n.targetKind, ...(n.targetId ? { id: n.targetId } : {}) } : null,
    ...(ann
      ? {
          announcement: {
            id: ann.id,
            audience: ann.audience === "INDIVIDUAL" ? "individual" : "all",
            body: ann.body,
            requiresAcknowledgement: ann.requiresAcknowledgement,
            acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
          },
        }
      : {}),
  };
}
