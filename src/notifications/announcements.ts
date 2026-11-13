import type { Announcement, AnnouncementAudience, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { AppError, Errors } from "../lib/errors.js";
import { composeDedupeKey, createNotification, usersWithCategoryDisabled } from "./service.js";

export interface NewAnnouncement {
  adminId: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  targetCashierId?: string | null;
  requiresAcknowledgement: boolean;
  supersedesId?: string | null;
}

/** Who an announcement is for RIGHT NOW: active Cashiers only (never Admins, never other roles). */
export async function announcementRecipients(db: Prisma.TransactionClient | typeof prisma, a: Pick<Announcement, "audience" | "targetCashierId">) {
  if (a.audience === "INDIVIDUAL") {
    if (!a.targetCashierId) return [];
    return db.user.findMany({ where: { id: a.targetCashierId, role: "CASHIER", status: "ACTIVE" }, select: { id: true, shopId: true } });
  }
  return db.user.findMany({ where: { role: "CASHIER", status: "ACTIVE" }, select: { id: true, shopId: true } });
}

const preview = (body: string) => (body.length > 200 ? `${body.slice(0, 199)}…` : body);

async function publish(a: Announcement): Promise<void> {
  const recipients = await announcementRecipients(prisma, a);
  await createNotification({
    audience: "CASHIER",
    type: "announcement.published",
    dedupeKey: `announcement:${a.id}`,
    title: a.title,
    message: preview(a.body),
    // contract: shopId is null for all-cashier announcements
    shopId: a.audience === "INDIVIDUAL" ? (recipients[0]?.shopId ?? null) : null,
    target: null,
    announcementId: a.id,
    recipientUserIds: recipients.map((r) => r.id),
    occurredAt: a.createdAt,
    // D-08: acknowledgement-required announcements are ALWAYS delivered.
    forceDeliver: a.requiresAcknowledgement,
  });
}

/**
 * D-21: creates and publishes an announcement. Content is immutable (a DB
 * trigger enforces it); a correction is a NEW announcement that `supersedes`
 * the old one — the old row only gains `supersededAt`.
 */
export async function createAnnouncement(input: NewAnnouncement): Promise<Announcement> {
  if (input.audience === "INDIVIDUAL") {
    if (!input.targetCashierId) throw Errors.validation("Choose the cashier this announcement is for.");
    const target = await prisma.user.findFirst({ where: { id: input.targetCashierId, role: "CASHIER", status: "ACTIVE" }, select: { id: true } });
    if (!target) throw Errors.notFound("That cashier was not found or is not active.", "CASHIER_NOT_FOUND");
  }

  let created: Announcement;
  try {
    created = await prisma.$transaction(async (tx) => {
      if (input.supersedesId) {
        const original = await tx.announcement.findUnique({ where: { id: input.supersedesId } });
        if (!original) throw Errors.notFound("The announcement to revise was not found.", "ANNOUNCEMENT_NOT_FOUND");
        if (original.supersededAt) throw new AppError(409, "ANNOUNCEMENT_ALREADY_REVISED", "This announcement has already been revised.");
        await tx.announcement.update({ where: { id: original.id }, data: { supersededAt: new Date() } });
      }
      return tx.announcement.create({
        data: {
          title: input.title,
          body: input.body,
          audience: input.audience,
          targetCashierId: input.audience === "INDIVIDUAL" ? input.targetCashierId : null,
          requiresAcknowledgement: input.requiresAcknowledgement,
          createdById: input.adminId,
          supersedesId: input.supersedesId ?? null,
        },
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") throw new AppError(409, "ANNOUNCEMENT_ALREADY_REVISED", "This announcement has already been revised.");
    throw err;
  }

  await publish(created);
  return created;
}

/**
 * Delivery top-up (B3.6): a Cashier approved AFTER an announcement was
 * published still receives it (D-08), and an interrupted publish is completed.
 * Existing recipient rows — including a Cashier's deletion marker — are never
 * touched (skipDuplicates). Superseded announcements are not pushed to new
 * recipients (the revision replaces them).
 */
export async function topUpAnnouncementDelivery(now: Date): Promise<{ examined: number; added: number }> {
  const live = await prisma.announcement.findMany({
    where: { supersededAt: null, createdAt: { gt: new Date(now.getTime() - 90 * 86_400_000) } },
  });
  let added = 0;
  for (const a of live) {
    const notification = await prisma.appNotification.findUnique({ where: { dedupeKey: composeDedupeKey("CASHIER", "announcement.published", `announcement:${a.id}`) } });
    if (!notification) {
      await publish(a); // publish never completed — finish it
      continue;
    }
    if (notification.expiresAt <= now) continue;
    const targets = await announcementRecipients(prisma, a);
    if (targets.length === 0) continue;
    const have = new Set(
      (await prisma.appNotificationRecipient.findMany({ where: { notificationId: notification.id }, select: { userId: true } })).map((r) => r.userId)
    );
    let missing = targets.map((t) => t.id).filter((id) => !have.has(id));
    if (!a.requiresAcknowledgement) {
      const off = await usersWithCategoryDisabled(prisma, missing, "ANNOUNCEMENT");
      missing = missing.filter((id) => !off.has(id));
    }
    if (missing.length === 0) continue;
    const res = await prisma.appNotificationRecipient.createMany({
      // late joiners see it as new: their copy is stamped now, not at the original publish time
      data: missing.map((userId) => ({ notificationId: notification.id, userId, createdAt: now })),
      skipDuplicates: true,
    });
    added += res.count;
  }
  return { examined: live.length, added };
}

