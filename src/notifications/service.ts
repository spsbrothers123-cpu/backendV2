import { randomUUID } from "node:crypto";
import type { NtfCategory, NtfSeverity, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { NOTIFICATION_DEFAULTS, LOCKED_CATEGORIES, typeDef, type Audience } from "./constants.js";
import { dispatchDelivery } from "./delivery.js";

type Db = Prisma.TransactionClient | PrismaClient;

export interface NewNotification {
  audience: Audience;
  /** canonical dotted type, must exist in TYPES for this audience */
  type: string;
  /**
   * Stable identity of the underlying fact (e.g. a bill id, a stock transition
   * id). The audience and type are added by the service. Same key ⇒ same
   * notification ⇒ inserted at most once (database-enforced).
   */
  dedupeKey: string;
  title: string;
  message: string;
  shopId?: string | null;
  target?: { kind: string; id?: string | null; route?: string | null } | null;
  recipientUserIds: string[];
  announcementId?: string | null;
  /** when the underlying thing happened; defaults to now, never in the future */
  occurredAt?: Date;
  /** D-08: deliver even if the recipient switched this category off */
  forceDeliver?: boolean;
}

export interface CreateResult {
  created: boolean;
  id: string | null;
  recipientCount: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function composeDedupeKey(audience: Audience, type: string, key: string): string {
  return `${type}|${audience}|${key}`;
}

export function computeExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + NOTIFICATION_DEFAULTS.retentionDays * 86_400_000);
}

/** Users who switched `category` off. Locked (security) categories can never be switched off. */
export async function usersWithCategoryDisabled(db: Db, userIds: string[], category: NtfCategory): Promise<Set<string>> {
  if (userIds.length === 0 || LOCKED_CATEGORIES.has(category)) return new Set();
  const rows = await db.notificationPreference.findMany({
    where: { userId: { in: userIds }, category, enabled: false },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/**
 * Creates one notification event and its recipient rows atomically and
 * idempotently:
 *   • the event insert is `ON CONFLICT ("dedupeKey") DO NOTHING` — a duplicate
 *     detector run, retry, or second backend instance inserts nothing;
 *   • recipients are only added by the run that actually inserted the event;
 *   • recipients who disabled the category are skipped (security is locked).
 * The event row is kept even with zero recipients, so a skipped event is not
 * re-evaluated forever.
 */
export async function createNotification(input: NewNotification, tx?: Prisma.TransactionClient): Promise<CreateResult> {
  const def = typeDef(input.type)?.[input.audience === "ADMIN" ? "admin" : "cashier"];
  if (!def) throw new Error(`Notification type "${input.type}" is not defined for ${input.audience}`);

  const run = async (tx: Db): Promise<CreateResult & { delivered: string[] }> => {
    const now = new Date();
    const createdAt = input.occurredAt && input.occurredAt < now ? input.occurredAt : now;
    const id = randomUUID();
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "app_notifications"
        ("id","dedupeKey","category","type","severity","title","message","shopId","targetKind","targetId","targetRoute","announcementId","createdAt","expiresAt")
      VALUES (${id}, ${composeDedupeKey(input.audience, input.type, input.dedupeKey)},
              ${def.category}::"NtfCategory", ${input.type}, ${def.severity}::"NtfSeverity",
              ${clip(input.title, 200)}, ${clip(input.message, 1000)}, ${input.shopId ?? null},
              ${input.target?.kind ?? null}, ${input.target?.id ?? null}, ${input.target?.route ?? null},
              ${input.announcementId ?? null}, ${createdAt.toISOString()}::timestamp, ${computeExpiry(createdAt).toISOString()}::timestamp)
      ON CONFLICT ("dedupeKey") DO NOTHING
      RETURNING "id"`;
    if (rows.length === 0) return { created: false, id: null, recipientCount: 0, delivered: [] };

    const unique = [...new Set(input.recipientUserIds)];
    const skip = input.forceDeliver ? new Set<string>() : await usersWithCategoryDisabled(tx, unique, def.category);
    const delivered = unique.filter((u) => !skip.has(u));
    if (delivered.length) {
      await tx.appNotificationRecipient.createMany({
        data: delivered.map((userId) => ({ notificationId: id, userId, createdAt })),
        skipDuplicates: true,
      });
    }
    return { created: true, id, recipientCount: delivered.length, delivered };
  };

  // `tx` given → join the caller's transaction (state change + notification commit together);
  // otherwise open our own so the event and its recipients are always atomic.
  const result = tx ? await run(tx) : await prisma.$transaction((t) => run(t));

  if (result.created && result.delivered.length) {
    void dispatchDelivery({
      notificationId: result.id!,
      audience: input.audience,
      type: input.type,
      recipientUserIds: result.delivered,
    });
  }
  return { created: result.created, id: result.id, recipientCount: result.recipientCount };
}

export type { NtfCategory, NtfSeverity };
