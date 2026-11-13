import type { DailySummaryKind, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { toNumber } from "../lib/money.js";
import { summarizeSession } from "../services/sessionService.js";
import { loadBranchConfigs } from "./config.js";
import { cashDifference, hasCashMismatch, isHighValueSale, isLargeCreditSale, toCents } from "./thresholds.js";
import { summaryApiId, summaryWindow, type SummaryKindKey } from "./schedule.js";
import { rupees } from "./sweepers/util.js";

export interface Metric {
  key: string;
  label: string;
  value: number | string;
  format: "currency" | "count" | "percent" | "text";
}

/** The 12 approved metrics (D-22), in display order. */
export const SUMMARY_METRIC_KEYS = [
  "sales",
  "bills",
  "payment_breakdown",
  "credit_sales",
  "collections",
  "outstanding_credit",
  "cash_mismatch",
  "high_value_sales",
  "large_credit_sales",
  "inventory_alerts",
  "sessions",
  "pending_announcements",
] as const;

interface BranchFigures {
  sales: number;
  bills: number;
  cash: number;
  card: number;
  upi: number;
  credit: number;
  collections: number;
  outstanding: number;
  mismatches: number;
  highValue: number;
  largeCredit: number;
  inventoryAlerts: number;
  sessions: number;
  pendingAnnouncements: number;
}

const zero = (): BranchFigures => ({
  sales: 0, bills: 0, cash: 0, card: 0, upi: 0, credit: 0, collections: 0, outstanding: 0,
  mismatches: 0, highValue: 0, largeCredit: 0, inventoryAlerts: 0, sessions: 0, pendingAnnouncements: 0,
});

/** Pure: figures → the 12 generic metrics the Admin page renders. */
export function toMetrics(f: BranchFigures): Metric[] {
  return [
    { key: "sales", label: "Net sales", value: f.sales, format: "currency" },
    { key: "bills", label: "Bills", value: f.bills, format: "count" },
    {
      key: "payment_breakdown",
      label: "Payment breakdown",
      value: `Cash ${rupees(f.cash)} · UPI ${rupees(f.upi)} · Card ${rupees(f.card)} · Credit ${rupees(f.credit)}`,
      format: "text",
    },
    { key: "credit_sales", label: "Credit sales", value: f.credit, format: "currency" },
    { key: "collections", label: "Credit collections", value: f.collections, format: "currency" },
    { key: "outstanding_credit", label: "Outstanding credit", value: f.outstanding, format: "currency" },
    { key: "cash_mismatch", label: "Cash mismatches", value: f.mismatches, format: "count" },
    { key: "high_value_sales", label: "High-value sales", value: f.highValue, format: "count" },
    { key: "large_credit_sales", label: "Large credit sales", value: f.largeCredit, format: "count" },
    { key: "inventory_alerts", label: "Inventory alerts", value: f.inventoryAlerts, format: "count" },
    { key: "sessions", label: "Sessions", value: f.sessions, format: "count" },
    { key: "pending_announcements", label: "Pending announcements", value: f.pendingAnnouncements, format: "count" },
  ];
}

export function sumFigures(all: BranchFigures[]): BranchFigures {
  const t = zero();
  for (const f of all) for (const k of Object.keys(t) as (keyof BranchFigures)[]) t[k] += f[k];
  return t;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Reads the window's figures for every branch straight from the business tables (read-only, D-23). */
export async function computeBranchFigures(start: Date, end: Date): Promise<{ shopId: string; name: string; figures: BranchFigures }[]> {
  const shops = await prisma.shop.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  const byShop = new Map<string, BranchFigures>(shops.map((s) => [s.id, zero()]));
  const cfgs = await loadBranchConfigs(prisma, shops.map((s) => s.id));
  const get = (id: string) => byShop.get(id) ?? zero();

  // Sales, bills, payments, high-value, large-credit — PAID bills paid inside the window.
  const bills = await prisma.bill.findMany({
    where: { status: "PAID", paidAt: { gte: start, lt: end } },
    select: { shopId: true, grandTotal: true, payments: { select: { method: true, amount: true } } },
  });
  for (const b of bills) {
    const f = get(b.shopId);
    const cfg = cfgs.get(b.shopId)!;
    const total = toNumber(b.grandTotal);
    f.sales += total;
    f.bills += 1;
    let credit = 0;
    for (const p of b.payments) {
      const amt = toNumber(p.amount);
      if (p.method === "CASH") f.cash += amt;
      else if (p.method === "CARD") f.card += amt;
      else if (p.method === "UPI") f.upi += amt;
      else if (p.method === "CREDIT") {
        f.credit += amt;
        credit += amt;
      }
    }
    if (isHighValueSale(total, cfg.highValueSaleThreshold)) f.highValue += 1;
    if (isLargeCreditSale(credit, cfg.largeCreditThreshold)) f.largeCredit += 1;
    byShop.set(b.shopId, f);
  }

  // Collections inside the window.
  const coll = await prisma.creditTransaction.groupBy({
    by: ["shopId"],
    where: { type: "COLLECTION", createdAt: { gte: start, lt: end } },
    _sum: { amount: true },
  });
  for (const c of coll) get(c.shopId).collections += toNumber(c._sum.amount);

  // Outstanding credit AS OF the window end, from the append-only ledger.
  const ledger = await prisma.creditTransaction.groupBy({
    by: ["shopId", "type"],
    where: { createdAt: { lt: end } },
    _sum: { amount: true },
  });
  const outstanding = new Map<string, number>();
  for (const l of ledger) {
    const sign = l.type === "CHARGE" ? 1 : -1;
    outstanding.set(l.shopId, (outstanding.get(l.shopId) ?? 0) + sign * toCents(toNumber(l._sum.amount)));
  }
  for (const [shopId, cents] of outstanding) get(shopId).outstanding = Math.max(0, cents) / 100;

  // Sessions opened / cash mismatches on sessions closed inside the window.
  const opened = await prisma.cashierSession.groupBy({ by: ["shopId"], where: { openedAt: { gte: start, lt: end } }, _count: { _all: true } });
  for (const o of opened) get(o.shopId).sessions += o._count._all;
  const closed = await prisma.cashierSession.findMany({
    where: { status: "CLOSED", closedAt: { gte: start, lt: end }, actualClosingCash: { not: null } },
    select: { id: true, shopId: true, openingCash: true, actualClosingCash: true },
  });
  for (const s of closed) {
    const summary = await summarizeSession(s.id);
    const expected = toNumber(s.openingCash) + summary.cashSales;
    const actual = toNumber(s.actualClosingCash);
    if (hasCashMismatch(actual, expected, cfgs.get(s.shopId)?.cashMismatchTolerance ?? 0) && cashDifference(actual, expected) !== 0) {
      get(s.shopId).mismatches += 1;
    }
  }

  // Inventory alerts raised in the window (Admin-audience events).
  const alerts = await prisma.appNotification.groupBy({
    by: ["shopId"],
    where: {
      createdAt: { gte: start, lt: end },
      OR: [
        { type: "inventory.low_stock", dedupeKey: { contains: "|ADMIN|" } },
        { type: "inventory.out_of_stock", dedupeKey: { contains: "|ADMIN|" } },
      ],
    },
    _count: { _all: true },
  });
  for (const a of alerts) if (a.shopId) get(a.shopId).inventoryAlerts += a._count._all;

  // Announcements still awaiting acknowledgement, per Cashier's branch (as of generation).
  const pending = await prisma.appNotificationRecipient.findMany({
    where: {
      acknowledgedAt: null,
      deletedAt: null,
      notification: { announcement: { requiresAcknowledgement: true } },
    },
    select: { user: { select: { shopId: true } } },
  });
  for (const p of pending) if (p.user.shopId) get(p.user.shopId).pendingAnnouncements += 1;

  return shops.map((s) => {
    const f = get(s.id);
    return {
      shopId: s.id,
      name: s.name,
      figures: { ...f, sales: r2(f.sales), cash: r2(f.cash), card: r2(f.card), upi: r2(f.upi), credit: r2(f.credit), collections: r2(f.collections), outstanding: r2(f.outstanding) },
    };
  });
}

export function summaryHeadline(date: string, kind: SummaryKindKey, sales: number, bills: number): { title: string; message: string } {
  return {
    title: kind === "MAIN" ? `Daily summary — ${date}` : `Late-night summary — ${date}`,
    message: `${rupees(sales)} across ${bills} bill${bills === 1 ? "" : "s"}${kind === "MAIN" ? " (12 AM–10 PM IST)." : " (10 PM–12 AM IST)."}`,
  };
}

/** Builds and stores (idempotently) one summary. Returns the stored row. */
export async function generateSummary(date: string, kind: SummaryKindKey) {
  const existing = await prisma.dailySummary.findUnique({ where: { businessDate_kind: { businessDate: date, kind } } });
  if (existing) return existing;

  const { start, end } = summaryWindow(date, kind);
  const branches = await computeBranchFigures(start, end);
  const total = sumFigures(branches.map((b) => b.figures));
  const data = {
    businessDate: date,
    kind: kind as DailySummaryKind,
    windowStart: start,
    windowEnd: end,
    metrics: toMetrics(total) as unknown as Prisma.InputJsonValue,
    branches: branches.map((b) => ({ branch: { id: b.shopId, name: b.name }, metrics: toMetrics(b.figures) })) as unknown as Prisma.InputJsonValue,
  };
  // (businessDate, kind) is unique: a concurrent instance's insert is simply skipped.
  await prisma.dailySummary.createMany({ data: [data], skipDuplicates: true });
  return prisma.dailySummary.findUniqueOrThrow({ where: { businessDate_kind: { businessDate: date, kind } } });
}

export function serializeSummary(row: {
  businessDate: string;
  kind: DailySummaryKind;
  windowStart: Date;
  windowEnd: Date;
  generatedAt: Date;
  metrics: unknown;
  branches: unknown;
}) {
  return {
    id: summaryApiId(row.businessDate, row.kind),
    businessDate: row.businessDate,
    kind: row.kind === "MAIN" ? "main" : "supplementary",
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    generatedAt: row.generatedAt.toISOString(),
    metrics: row.metrics,
    branches: row.branches,
  };
}
