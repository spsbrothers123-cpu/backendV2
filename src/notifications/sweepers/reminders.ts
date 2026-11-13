import { prisma } from "../../lib/prisma.js";
import { istStartOfDay } from "../../lib/ist.js";
import { loadBranchConfigs } from "../config.js";
import { liveReminderSlots } from "../schedule.js";
import { createNotification } from "../service.js";
import { resolveBranchCashierRecipients } from "../recipients.js";
import type { SweepJob } from "./types.js";

/**
 * D-18 opening / closing reminders. Branch times are nullable IST "HH:MM"
 * (branch_notification_settings); a branch without a time gets no reminder.
 * Cashier-only. Opening: only if the branch has not opened a session since
 * the start of that IST day. Closing: only if a session is still OPEN.
 * Dedupe per (branch, IST date, kind), so ticks, retries and several
 * instances send at most one.
 */
export const reminderSweep: SweepJob = {
  key: "sweep.reminders",
  intervalMs: 60_000,
  watermarked: false,
  async run({ now }) {
    const branches = await prisma.branchNotificationSettings.findMany({
      where: { OR: [{ openingTime: { not: null } }, { closingTime: { not: null } }] },
      select: { shopId: true, shop: { select: { name: true } } },
    });
    if (branches.length === 0) return { examined: 0, created: 0 };
    const cfgs = await loadBranchConfigs(prisma, branches.map((b) => b.shopId));
    let created = 0;
    let failures = 0;

    for (const b of branches) {
      const cfg = cfgs.get(b.shopId)!;
      for (const slot of liveReminderSlots(now, cfg)) {
        try {
          const dayStart = istStartOfDay(slot.date);
          let needed: boolean;
          if (slot.kind === "opening") {
            needed = (await prisma.cashierSession.count({ where: { shopId: b.shopId, openedAt: { gte: dayStart, lte: now } } })) === 0;
          } else {
            needed = (await prisma.cashierSession.count({ where: { shopId: b.shopId, status: "OPEN" } })) > 0;
          }
          if (!needed) continue;
          const r = await createNotification({
            audience: "CASHIER",
            type: slot.kind === "opening" ? "reminder.opening" : "reminder.closing",
            dedupeKey: `${b.shopId}:${slot.date}`,
            title: slot.kind === "opening" ? "Time to open your session" : "Time to close your session",
            message:
              slot.kind === "opening"
                ? `${b.shop.name} opens now. Start your session when you're ready.`
                : `${b.shop.name} is due to close. Count your cash and close your session.`,
            shopId: b.shopId,
            target: { kind: "session" },
            recipientUserIds: await resolveBranchCashierRecipients(prisma, b.shopId),
            occurredAt: slot.slotAt,
          });
          if (r.created) created++;
        } catch (err) {
          failures++;
          console.error("reminder sweep failed", { shopId: b.shopId, error: (err as Error).message });
        }
      }
    }
    return { examined: branches.length, created, failures };
  },
};
