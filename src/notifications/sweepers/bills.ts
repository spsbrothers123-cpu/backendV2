import { prisma } from "../../lib/prisma.js";
import { toNumber } from "../../lib/money.js";
import { loadBranchConfigs } from "../config.js";
import { isHighValueSale, isLargeCreditSale } from "../thresholds.js";
import { createNotification } from "../service.js";
import { resolveCentralAdminRecipients } from "../recipients.js";
import { afterKey, drain, type Cursor, rupees } from "./util.js";
import type { SweepJob } from "./types.js";

/**
 * D-19: high-value (>= ₹5,000 sale total) and large-credit (>= ₹10,000 on
 * credit) alerts. Read-only over `bills`/`payments` (D-23). One notification
 * per bill per trigger — the bill id IS the dedupe key. Admin only: Cashiers
 * don't receive transaction alerts (Cashier contract). Cancelled/held bills
 * are ignored (only PAID).
 */
export const billSweep: SweepJob = {
  key: "sweep.bills",
  intervalMs: 60_000,
  watermarked: true,
  async run({ since }) {
    return drain({
      ts: (b) => b.paidAt!,
      fetch: async (after: Cursor, take: number) => {
        const rows = await prisma.bill.findMany({
          where: { status: "PAID", paidAt: { gte: since }, ...afterKey("paidAt", after) },
          orderBy: [{ paidAt: "asc" }, { id: "asc" }],
          take,
          include: { payments: { select: { method: true, amount: true } }, shop: { select: { name: true } }, customer: { select: { name: true } } },
        });
        return rows;
      },
      handle: async (bill) => {
        const cfg = (await loadBranchConfigs(prisma, [bill.shopId])).get(bill.shopId)!;
        const admins = await resolveCentralAdminRecipients(prisma);
        const label = bill.billNumber ?? bill.id.slice(0, 8);
        const target = { kind: "bill", id: bill.id };
        let created = 0;

        const total = toNumber(bill.grandTotal);
        if (isHighValueSale(total, cfg.highValueSaleThreshold)) {
          const r = await createNotification({
            audience: "ADMIN",
            type: "sales.high_value",
            dedupeKey: `bill:${bill.id}`,
            title: `High-value sale: ${rupees(total)}`,
            message: `Bill ${label} at ${bill.shop.name}.`,
            shopId: bill.shopId,
            target,
            recipientUserIds: admins,
            occurredAt: bill.paidAt!,
          });
          if (r.created) created++;
        }

        const credit = bill.payments.filter((p) => p.method === "CREDIT").reduce((s, p) => s + toNumber(p.amount), 0);
        if (isLargeCreditSale(credit, cfg.largeCreditThreshold)) {
          const r = await createNotification({
            audience: "ADMIN",
            type: "credit.large_sale",
            dedupeKey: `bill:${bill.id}`,
            title: `Large credit sale: ${rupees(credit)}`,
            message: `Bill ${label} at ${bill.shop.name}${bill.customer ? ` for ${bill.customer.name}` : ""}.`,
            shopId: bill.shopId,
            target,
            recipientUserIds: admins,
            occurredAt: bill.paidAt!,
          });
          if (r.created) created++;
        }
        return created;
      },
    });
  },
};
