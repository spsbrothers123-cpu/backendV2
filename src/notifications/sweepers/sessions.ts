import { prisma } from "../../lib/prisma.js";
import { toNumber } from "../../lib/money.js";
import { summarizeSession } from "../../services/sessionService.js";
import { loadBranchConfigs } from "../config.js";
import { cashDifference, hasCashMismatch } from "../thresholds.js";
import { createNotification } from "../service.js";
import { resolveBranchCashierRecipients, resolveCentralAdminRecipients } from "../recipients.js";
import { afterKey, drain, type Cursor, rupees } from "./util.js";
import type { SweepJob } from "./types.js";

type Sess = { id: string; shopId: string; cashierId: string; shop: { name: string }; cashier: { name: string } };

async function both(
  s: Sess,
  type: "session.opened" | "session.closed" | "cash.mismatch",
  dedupeKey: string,
  copy: { title: string; message: string },
  occurredAt: Date,
  adminCopy?: { title: string; message: string }
): Promise<number> {
  const [admins, cashiers] = await Promise.all([resolveCentralAdminRecipients(prisma), resolveBranchCashierRecipients(prisma, s.shopId)]);
  const target = { kind: "session", id: s.id };
  const a = await createNotification({ audience: "ADMIN", type, dedupeKey, shopId: s.shopId, target, recipientUserIds: admins, occurredAt, ...(adminCopy ?? copy) });
  // Only the session's own Cashier hears about it (never another branch's).
  const c = await createNotification({ audience: "CASHIER", type, dedupeKey, shopId: s.shopId, target, recipientUserIds: cashiers.filter((id) => id === s.cashierId), occurredAt, ...copy });
  return (a.created ? 1 : 0) + (c.created ? 1 : 0);
}

const sessionInclude = { shop: { select: { name: true } }, cashier: { select: { name: true } } } as const;

export const sessionOpenedSweep: SweepJob = {
  key: "sweep.session.opened",
  intervalMs: 60_000,
  watermarked: true,
  async run({ since }) {
    return drain({
      ts: (s) => s.openedAt,
      fetch: (after: Cursor, take: number) =>
        prisma.cashierSession.findMany({
          where: { openedAt: { gte: since }, ...afterKey("openedAt", after) },
          orderBy: [{ openedAt: "asc" }, { id: "asc" }],
          take,
          include: sessionInclude,
        }),
      handle: (s) =>
        both(
          s,
          "session.opened",
          `session:${s.id}:open`,
          { title: "Session opened", message: `Your session started with ${rupees(toNumber(s.openingCash))} opening cash.` },
          s.openedAt,
          { title: `Session opened at ${s.shop.name}`, message: `${s.cashier.name} opened a session with ${rupees(toNumber(s.openingCash))}.` }
        ),
    });
  },
};

/**
 * Session closed + cash mismatch (D-19: zero tolerance — any non-zero
 * difference). Expected cash is the app's own formula (opening cash + CASH
 * payments on PAID bills, see routes/sessions.ts), evaluated when the sweep
 * sees the closed session.
 */
export const sessionClosedSweep: SweepJob = {
  key: "sweep.session.closed",
  intervalMs: 60_000,
  watermarked: true,
  async run({ since }) {
    return drain({
      ts: (s) => s.closedAt!,
      fetch: (after: Cursor, take: number) =>
        prisma.cashierSession.findMany({
          where: { status: "CLOSED", closedAt: { gte: since }, ...afterKey("closedAt", after) },
          orderBy: [{ closedAt: "asc" }, { id: "asc" }],
          take,
          include: sessionInclude,
        }),
      handle: async (s) => {
        let created = await both(
          s,
          "session.closed",
          `session:${s.id}:close`,
          { title: "Session closed", message: "Your session was closed." },
          s.closedAt!,
          { title: `Session closed at ${s.shop.name}`, message: `${s.cashier.name} closed their session.` }
        );
        if (s.actualClosingCash === null) return created;
        const summary = await summarizeSession(s.id);
        const expected = toNumber(s.openingCash) + summary.cashSales;
        const actual = toNumber(s.actualClosingCash);
        const cfg = (await loadBranchConfigs(prisma, [s.shopId])).get(s.shopId)!;
        if (hasCashMismatch(actual, expected, cfg.cashMismatchTolerance)) {
          const diff = cashDifference(actual, expected);
          const word = diff < 0 ? "short" : "over";
          created += await both(
            s,
            "cash.mismatch",
            `session:${s.id}`,
            { title: "Cash mismatch", message: `Counted ${rupees(actual)} but expected ${rupees(expected)} — ${rupees(Math.abs(diff))} ${word}.` },
            s.closedAt!,
            { title: `Cash mismatch at ${s.shop.name}`, message: `${s.cashier.name}: counted ${rupees(actual)}, expected ${rupees(expected)} (${rupees(Math.abs(diff))} ${word}).` }
          );
        }
        return created;
      },
    });
  },
};
