import { inventorySweep } from "./sweepers/inventory.js";
import { billSweep } from "./sweepers/bills.js";
import { creditAdjustedSweep, creditClearedSweep, creditOverdueSweep } from "./sweepers/credit.js";
import { sessionClosedSweep, sessionOpenedSweep } from "./sweepers/sessions.js";
import { securitySweep } from "./sweepers/security.js";
import { reminderSweep } from "./sweepers/reminders.js";
import { dailySummarySweep } from "./sweepers/dailySummary.js";
import { announcementDeliverySweep } from "./sweepers/announcements.js";
import { retentionSweep } from "./sweepers/retention.js";
import type { SweepJob } from "./sweepers/types.js";

/** Every background notification job (D-23). Order = tick order. */
export const NOTIFICATION_JOBS: SweepJob[] = [
  inventorySweep,
  billSweep,
  creditClearedSweep,
  creditAdjustedSweep,
  creditOverdueSweep,
  sessionOpenedSweep,
  sessionClosedSweep,
  securitySweep,
  reminderSweep,
  dailySummarySweep,
  announcementDeliverySweep,
  retentionSweep,
];
