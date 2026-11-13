import { topUpAnnouncementDelivery } from "../announcements.js";
import type { SweepJob } from "./types.js";

export const announcementDeliverySweep: SweepJob = {
  key: "sweep.announcements",
  intervalMs: 5 * 60_000,
  watermarked: false,
  async run({ now }) {
    const { examined, added } = await topUpAnnouncementDelivery(now);
    return { examined, created: added };
  },
};
