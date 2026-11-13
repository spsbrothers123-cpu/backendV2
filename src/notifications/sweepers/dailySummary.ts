import { prisma } from "../../lib/prisma.js";
import { dueSummaries, summaryApiId, summaryDueAt } from "../schedule.js";
import { generateSummary, summaryHeadline } from "../dailySummary.js";
import { createNotification, composeDedupeKey } from "../service.js";
import { resolveCentralAdminRecipients } from "../recipients.js";
import type { SweepJob } from "./types.js";

/**
 * D-22: MAIN at 10:00 PM IST (12 AM–10 PM) and SUPPLEMENTARY at 12:05 AM IST
 * (10 PM–12 AM). Every tick considers the last few business days, so a backend
 * that was down at 10 PM still produces the 10 PM summary when it returns
 * (catch-up) — the stored window is fixed by the schedule, not by when it ran.
 * Both the stored row and the notification are idempotent, so a crash between
 * the two heals on the next tick.
 */
export const dailySummarySweep: SweepJob = {
  key: "sweep.daily_summary",
  intervalMs: 60_000,
  watermarked: false,
  async run({ now }) {
    let created = 0;
    let failures = 0;
    const slots = dueSummaries(now);
    for (const slot of slots) {
      try {
        const dedupe = composeDedupeKey("ADMIN", "summary.daily", `${slot.date}:${slot.kind}`);
        const hasNotification = await prisma.appNotification.findUnique({ where: { dedupeKey: dedupe }, select: { id: true } });
        const stored = await prisma.dailySummary.findUnique({ where: { businessDate_kind: { businessDate: slot.date, kind: slot.kind } } });
        if (stored && hasNotification) continue;

        const row = stored ?? (await generateSummary(slot.date, slot.kind));
        const metrics = row.metrics as { key: string; value: number | string }[];
        const sales = Number(metrics.find((m) => m.key === "sales")?.value ?? 0);
        const bills = Number(metrics.find((m) => m.key === "bills")?.value ?? 0);
        const head = summaryHeadline(slot.date, slot.kind, sales, bills);
        const r = await createNotification({
          audience: "ADMIN",
          type: "summary.daily",
          dedupeKey: `${slot.date}:${slot.kind}`,
          ...head,
          target: { kind: "daily_summary", id: summaryApiId(slot.date, slot.kind) },
          recipientUserIds: await resolveCentralAdminRecipients(prisma),
          occurredAt: summaryDueAt(slot.date, slot.kind),
        });
        if (!stored || r.created) created++;
      } catch (err) {
        failures++;
        console.error("daily summary failed", { date: slot.date, kind: slot.kind, error: (err as Error).message });
      }
    }
    return { examined: slots.length, created, failures };
  },
};
