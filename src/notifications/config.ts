import type { Prisma, PrismaClient } from "@prisma/client";
import { NOTIFICATION_DEFAULTS } from "./constants.js";
import { parseHHMM } from "../lib/ist.js";
import { toNumber } from "../lib/money.js";
import { effectiveLowStockThreshold } from "./thresholds.js";

type Db = Prisma.TransactionClient | PrismaClient;

export interface BranchConfig {
  shopId: string;
  highValueSaleThreshold: number;
  largeCreditThreshold: number;
  cashMismatchTolerance: number;
  creditOverdueDays: number;
  /** minutes after 00:00 IST, or null when the branch has no reminder time */
  openingMinutes: number | null;
  closingMinutes: number | null;
}

interface SettingsRow {
  openingTime: string | null;
  closingTime: string | null;
  highValueSaleThreshold: Prisma.Decimal | null;
  largeCreditThreshold: Prisma.Decimal | null;
  creditOverdueDays: number | null;
}

/** Pure: layer a branch's nullable overrides over the global defaults. */
export function resolveBranchConfig(shopId: string, row: SettingsRow | null | undefined): BranchConfig {
  return {
    shopId,
    highValueSaleThreshold: row?.highValueSaleThreshold ? toNumber(row.highValueSaleThreshold) : NOTIFICATION_DEFAULTS.highValueSaleThreshold,
    largeCreditThreshold: row?.largeCreditThreshold ? toNumber(row.largeCreditThreshold) : NOTIFICATION_DEFAULTS.largeCreditThreshold,
    cashMismatchTolerance: NOTIFICATION_DEFAULTS.cashMismatchTolerance,
    creditOverdueDays: row?.creditOverdueDays ?? NOTIFICATION_DEFAULTS.creditOverdueDays,
    openingMinutes: parseHHMM(row?.openingTime),
    closingMinutes: parseHHMM(row?.closingTime),
  };
}

export async function loadBranchConfigs(db: Db, shopIds: string[]): Promise<Map<string, BranchConfig>> {
  const unique = [...new Set(shopIds)];
  const rows = unique.length
    ? await db.branchNotificationSettings.findMany({ where: { shopId: { in: unique } } })
    : [];
  const byShop = new Map(rows.map((r) => [r.shopId, r]));
  return new Map(unique.map((id) => [id, resolveBranchConfig(id, byShop.get(id))]));
}

export async function loadBranchConfig(db: Db, shopId: string): Promise<BranchConfig> {
  return (await loadBranchConfigs(db, [shopId])).get(shopId)!;
}

/** Shared D-17 helper: the ONE place a (branch, product) low-stock threshold is decided. */
export async function loadLowStockThresholds(
  db: Db,
  pairs: { shopId: string; productId: string; productThreshold: number }[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pairs.length === 0) return out;
  const overrides = await db.branchProductLowStock.findMany({
    where: { OR: [...new Set(pairs.map((p) => p.shopId))].map((shopId) => ({ shopId })) },
  });
  const byKey = new Map(overrides.map((o) => [`${o.shopId}:${o.productId}`, o.lowStockThreshold]));
  for (const p of pairs) {
    const key = `${p.shopId}:${p.productId}`;
    out.set(key, effectiveLowStockThreshold(p.productThreshold, byKey.get(key)));
  }
  return out;
}
