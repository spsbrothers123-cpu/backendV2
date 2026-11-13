import { prisma } from "../../lib/prisma.js";
import { toNumber } from "../../lib/money.js";
import { loadBranchConfigs } from "../config.js";
import { isCreditOverdue, oldestUnpaidCharge, toCents, type LedgerRow } from "../thresholds.js";
import { createNotification } from "../service.js";
import { resolveCentralAdminRecipients, resolveCustomerOwnerRecipients } from "../recipients.js";
import { afterKey, drain, type Cursor, istLabel, rupees } from "./util.js";
import type { SweepJob } from "./types.js";

/** Notify the Central Admin and — D-14 — only the Cashier who owns the customer. */
async function notifyCredit(args: {
  type: "credit.cleared" | "credit.adjusted" | "credit.overdue";
  dedupeKey: string;
  shopId: string;
  customerId: string;
  title: string;
  message: string;
  occurredAt?: Date;
}): Promise<number> {
  const [admins, owners] = await Promise.all([
    resolveCentralAdminRecipients(prisma),
    resolveCustomerOwnerRecipients(prisma, args.shopId, args.customerId),
  ]);
  const common = { type: args.type, dedupeKey: args.dedupeKey, title: args.title, message: args.message, shopId: args.shopId, occurredAt: args.occurredAt };
  // Never create an event nobody will receive: an empty event row would consume
  // the (global, unique) dedupe key and permanently block the alert if an owner
  // or Central Admin appears later. Skip the audience instead.
  const skipped = { created: false } as const;
  const a = admins.length
    ? await createNotification({ ...common, audience: "ADMIN", target: { kind: "credit", id: args.customerId }, recipientUserIds: admins })
    : skipped;
  const c = owners.length
    ? await createNotification({ ...common, audience: "CASHIER", target: { kind: "credit_customer", id: args.customerId }, recipientUserIds: owners })
    : skipped;
  return (a.created ? 1 : 0) + (c.created ? 1 : 0);
}

const SIGN = { CHARGE: 1, COLLECTION: -1, REVERSAL: -1 } as const;

/** Credit cleared: a collection that takes the customer's running balance to zero. */
export const creditClearedSweep: SweepJob = {
  key: "sweep.credit.cleared",
  intervalMs: 60_000,
  watermarked: true,
  async run({ since }) {
    return drain({
      ts: (t) => t.createdAt,
      fetch: (after: Cursor, take: number) =>
        prisma.creditTransaction.findMany({
          where: { type: "COLLECTION", createdAt: { gte: since }, ...afterKey("createdAt", after) },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
          include: { customer: { select: { name: true } } },
        }),
      handle: async (txn) => {
        // Balance immediately before / after this collection, from the append-only ledger.
        const earlier = await prisma.creditTransaction.findMany({
          where: { customerId: txn.customerId, OR: [{ createdAt: { lt: txn.createdAt } }, { createdAt: txn.createdAt, id: { lt: txn.id } }] },
          select: { type: true, amount: true },
        });
        const before = earlier.reduce((s, r) => s + SIGN[r.type] * toCents(toNumber(r.amount)), 0);
        const after = before - toCents(toNumber(txn.amount));
        if (!(before > 0 && after <= 0)) return 0;
        return notifyCredit({
          type: "credit.cleared",
          dedupeKey: `txn:${txn.id}`,
          shopId: txn.shopId,
          customerId: txn.customerId,
          title: `Credit cleared: ${txn.customer.name}`,
          message: `${txn.customer.name} has paid off their outstanding credit.`,
          occurredAt: txn.createdAt,
        });
      },
    });
  },
};

/**
 * D-16: manual credit adjustment. The current schema has no dedicated
 * ADJUSTMENT ledger type (adding one would be a billing change — out of scope,
 * D-15/D-23), so a manual adjustment is a ledger CHARGE with no bill. No code
 * path writes one today; this detector is ready for the day one does.
 */
export const creditAdjustedSweep: SweepJob = {
  key: "sweep.credit.adjusted",
  intervalMs: 60_000,
  watermarked: true,
  async run({ since }) {
    return drain({
      ts: (t) => t.createdAt,
      fetch: (after: Cursor, take: number) =>
        prisma.creditTransaction.findMany({
          where: { type: "CHARGE", billId: null, createdAt: { gte: since }, ...afterKey("createdAt", after) },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take,
          include: { customer: { select: { name: true } } },
        }),
      handle: (txn) =>
        notifyCredit({
          type: "credit.adjusted",
          dedupeKey: `txn:${txn.id}`,
          shopId: txn.shopId,
          customerId: txn.customerId,
          title: `Credit adjusted: ${txn.customer.name}`,
          message: `A manual adjustment of ${rupees(toNumber(txn.amount))} was recorded.`,
          occurredAt: txn.createdAt,
        }),
    });
  },
};

/**
 * Overdue credit. D-15 gates due dates, so overdue = the oldest still-unpaid
 * charge (FIFO) is older than the branch's creditOverdueDays. One alert per
 * overdue "episode": the dedupe key is the oldest unpaid charge's id, so a new
 * alert needs a new oldest-unpaid charge (i.e. the old one was settled).
 */
export const creditOverdueSweep: SweepJob = {
  key: "sweep.credit.overdue",
  intervalMs: 60 * 60_000,
  watermarked: false,
  async run({ now }) {
    const customers = await prisma.customer.findMany({
      where: { creditBalance: { gt: 0 } },
      select: { id: true, name: true, shopId: true, creditBalance: true },
    });
    if (customers.length === 0) return { examined: 0, created: 0 };
    const cfgs = await loadBranchConfigs(prisma, customers.map((c) => c.shopId));
    let created = 0;
    let failures = 0;
    for (const c of customers) {
      try {
        const rows = await prisma.creditTransaction.findMany({
          where: { customerId: c.id },
          select: { id: true, type: true, amount: true, createdAt: true },
        });
        const ledger: LedgerRow[] = rows.map((r) => ({ id: r.id, type: r.type, amountCents: toCents(toNumber(r.amount)), createdAt: r.createdAt }));
        const oldest = oldestUnpaidCharge(ledger);
        if (!oldest || !isCreditOverdue(oldest.createdAt, now, cfgs.get(c.shopId)!.creditOverdueDays)) continue;
        created += await notifyCredit({
          type: "credit.overdue",
          dedupeKey: `customer:${c.id}:${oldest.id ?? oldest.createdAt.getTime()}`,
          shopId: c.shopId,
          customerId: c.id,
          title: `Overdue credit: ${c.name}`,
          message: `${rupees(toNumber(c.creditBalance))} outstanding; oldest unpaid credit is from ${istLabel(oldest.createdAt)}.`,
        });
      } catch (err) {
        failures++;
        console.error("credit overdue sweep failed", { customerId: c.id, error: (err as Error).message });
      }
    }
    return { examined: customers.length, created, failures };
  },
};
