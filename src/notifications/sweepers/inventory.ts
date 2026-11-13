import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getStockByBranchProduct } from "../../services/inventoryService.js";
import { loadLowStockThresholds } from "../config.js";
import { stockState, stockTransitionEvent, type StockEvent } from "../thresholds.js";
import { createNotification } from "../service.js";
import { resolveBranchCashierRecipients, resolveCentralAdminRecipients } from "../recipients.js";
import type { SweepJob } from "./types.js";

const COPY: Record<StockEvent, (p: string, qty: number, shop: string, thr: number) => { title: string; message: string }> = {
  "inventory.low_stock": (p, q, s, t) => ({ title: `${p} is low`, message: `${q} left at ${s} (alert level ${t}).` }),
  "inventory.out_of_stock": (p, _q, s) => ({ title: `${p} is out of stock`, message: `No stock left at ${s}.` }),
  "inventory.restocked": (p, q, s) => ({ title: `${p} was restocked`, message: `${q} now available at ${s}.` }),
};

/**
 * D-23/D-17: stock alerts WITHOUT touching adjustStock/billing. Compares each
 * assigned (branch, product)'s current stock — read through the existing
 * inventory-mode-aware helpers — with the last state we recorded, and alerts
 * once per transition. State + notification are written in ONE transaction, so
 * a crash can neither lose an alert nor repeat one.
 */
export const inventorySweep: SweepJob = {
  key: "sweep.inventory",
  intervalMs: 60_000,
  watermarked: false,
  async run() {
    const assigned = await prisma.branchProduct.findMany({
      where: { isAssigned: true, product: { status: "ACTIVE" } },
      select: {
        shopId: true,
        shop: { select: { name: true } },
        product: { select: { id: true, name: true, lowStockThreshold: true } },
      },
    });
    if (assigned.length === 0) return { examined: 0, created: 0 };

    const shopIds = [...new Set(assigned.map((a) => a.shopId))];
    const productIds = [...new Set(assigned.map((a) => a.product.id))];
    const stock = await getStockByBranchProduct(prisma, shopIds, productIds); // only products that have stock rows
    const thresholds = await loadLowStockThresholds(
      prisma,
      assigned.map((a) => ({ shopId: a.shopId, productId: a.product.id, productThreshold: a.product.lowStockThreshold }))
    );
    const states = await prisma.notificationStockState.findMany({ where: { shopId: { in: shopIds } } });
    const stateByKey = new Map(states.map((s) => [`${s.shopId}:${s.productId}`, s]));
    const admins = await resolveCentralAdminRecipients(prisma);
    const cashiersByShop = new Map<string, string[]>();
    for (const id of shopIds) cashiersByShop.set(id, await resolveBranchCashierRecipients(prisma, id));

    let created = 0;
    let failures = 0;
    for (const a of assigned) {
      const key = `${a.shopId}:${a.product.id}`;
      const qty = stock.get(key);
      if (qty === undefined) continue; // never stocked here → nothing to alert about
      const next = stockState(qty, thresholds.get(key) ?? a.product.lowStockThreshold);
      const prev = stateByKey.get(key) ?? null;
      if (prev?.state === next) continue;
      const event = stockTransitionEvent(prev?.state ?? null, next);

      try {
        created += await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          let seq: number;
          if (!prev) {
            const row = await tx.notificationStockState.upsert({
              where: { shopId_productId: { shopId: a.shopId, productId: a.product.id } },
              create: { shopId: a.shopId, productId: a.product.id, state: next, seq: 1 },
              update: {},
            });
            seq = row.seq;
            if (row.state !== next) return 0; // another instance recorded a different state first; next run reconciles
          } else {
            const res = await tx.notificationStockState.updateMany({
              where: { id: prev.id, seq: prev.seq },
              data: { state: next, seq: prev.seq + 1 },
            });
            if (res.count === 0) return 0; // lost the race to another instance
            seq = prev.seq + 1;
          }
          if (!event) return 0;
          const copy = COPY[event](a.product.name, qty, a.shop.name, thresholds.get(key) ?? 0);
          const base = { type: event, dedupeKey: `${key}:${seq}`, shopId: a.shopId, target: { kind: "product", id: a.product.id }, ...copy };
          const r1 = await createNotification({ ...base, audience: "ADMIN", recipientUserIds: admins }, tx);
          const r2 = await createNotification({ ...base, audience: "CASHIER", recipientUserIds: cashiersByShop.get(a.shopId) ?? [] }, tx);
          return (r1.created ? 1 : 0) + (r2.created ? 1 : 0);
        });
      } catch (err) {
        failures++;
        console.error("inventory sweep failed", { shopId: a.shopId, productId: a.product.id, error: (err as Error).message });
      }
    }
    return { examined: assigned.length, created, failures };
  },
};
