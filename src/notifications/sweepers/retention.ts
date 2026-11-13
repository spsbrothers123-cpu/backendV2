import { prisma } from "../../lib/prisma.js";
import { addDays, istDateString } from "../../lib/ist.js";
import { NOTIFICATION_DEFAULTS } from "../constants.js";
import type { SweepJob } from "./types.js";

const CHUNK = 1000;

/**
 * D-10: 90-day retention. A notification — and with it every recipient row,
 * including deletion markers — is removed once its `expiresAt` passes. Because
 * markers share the notification's lifetime, a deleted notification can never
 * reappear before it would have expired anyway. Read status never matters.
 * Stored daily summaries expire on the same 90-day horizon.
 */
export const retentionSweep: SweepJob = {
  key: "sweep.retention",
  intervalMs: 60 * 60_000,
  watermarked: false,
  async run({ now }) {
    let removed = 0;
    for (let i = 0; i < 20; i++) {
      const ids = await prisma.appNotification.findMany({ where: { expiresAt: { lt: now } }, select: { id: true }, take: CHUNK });
      if (ids.length === 0) break;
      const res = await prisma.appNotification.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
      removed += res.count;
      if (ids.length < CHUNK) break;
    }
    const cutoffDate = addDays(istDateString(now), -NOTIFICATION_DEFAULTS.retentionDays);
    const summaries = await prisma.dailySummary.deleteMany({ where: { businessDate: { lt: cutoffDate } } });
    return { examined: removed + summaries.count, created: 0 };
  },
};
