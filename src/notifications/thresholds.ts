/**
 * Pure business-rule helpers for notification detection. No I/O, no clock, no
 * Prisma: every threshold decision lives here so it is defined once (Phase 3
 * §8) and is unit-testable. Money is compared in integer cents — never floats.
 */
import type { NtfStockState } from "@prisma/client";

export function toCents(amount: number | string): number {
  return Math.round(Number(amount) * 100);
}

/** D-19: inclusive `>=` comparison on monetary thresholds. */
export function isAtLeast(amount: number | string, threshold: number | string): boolean {
  return toCents(amount) >= toCents(threshold);
}

export const isHighValueSale = (grandTotal: number | string, threshold: number | string) => isAtLeast(grandTotal, threshold);
export const isLargeCreditSale = (creditAmount: number | string, threshold: number | string) =>
  toCents(creditAmount) > 0 && isAtLeast(creditAmount, threshold);

/** D-19: zero tolerance by default — ANY non-zero difference is a mismatch. */
export function hasCashMismatch(actual: number | string, expected: number | string, tolerance: number | string = 0): boolean {
  return Math.abs(toCents(actual) - toCents(expected)) > toCents(tolerance);
}

/** Signed difference (actual − expected) in rupees, 2dp. */
export function cashDifference(actual: number | string, expected: number | string): number {
  return (toCents(actual) - toCents(expected)) / 100;
}

// ── Stock (D-17) ─────────────────────────────────────────────────────
/** Same rule as serializeAdmin.productStatusLabel: <=0 out, <=threshold low. */
export function stockState(quantity: number, threshold: number): NtfStockState {
  if (quantity <= 0) return "OUT";
  if (quantity <= threshold) return "LOW";
  return "OK";
}

/** D-17: branch override wins; Product.lowStockThreshold is the global fallback. */
export function effectiveLowStockThreshold(productThreshold: number, branchOverride: number | null | undefined): number {
  return branchOverride ?? productThreshold;
}

export type StockEvent = "inventory.low_stock" | "inventory.out_of_stock" | "inventory.restocked";

/** One alert per stock-state TRANSITION; `prev` null = never observed. */
export function stockTransitionEvent(prev: NtfStockState | null, next: NtfStockState): StockEvent | null {
  if (prev === next) return null;
  if (next === "OUT") return "inventory.out_of_stock";
  if (next === "LOW") return prev === "OUT" ? "inventory.restocked" : "inventory.low_stock";
  // next === "OK"
  return prev === null ? null : "inventory.restocked";
}

// ── Credit ───────────────────────────────────────────────────────────
export interface LedgerRow {
  id?: string;
  type: "CHARGE" | "COLLECTION" | "REVERSAL";
  amountCents: number;
  createdAt: Date;
}

/**
 * FIFO ageing: collections and reversals settle the OLDEST charges first.
 * Returns the oldest charge that is still (partly) unpaid, or null if settled.
 */
export function oldestUnpaidCharge(rows: LedgerRow[]): { id?: string; createdAt: Date; unpaidCents: number } | null {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  let credits = sorted.filter((r) => r.type !== "CHARGE").reduce((s, r) => s + r.amountCents, 0);
  for (const r of sorted) {
    if (r.type !== "CHARGE") continue;
    if (credits >= r.amountCents) {
      credits -= r.amountCents;
      continue;
    }
    return { id: r.id, createdAt: r.createdAt, unpaidCents: r.amountCents - credits };
  }
  return null;
}

export function isCreditOverdue(chargedAt: Date, now: Date, overdueDays: number): boolean {
  return now.getTime() - chargedAt.getTime() >= overdueDays * 86_400_000;
}

// ── Security (D-20) ──────────────────────────────────────────────────
export interface FailedAttempt {
  id: string;
  at: Date;
}

export interface FailedLoginBurst {
  /** id of the FIRST attempt in the burst — stable, so it is the dedupe identity */
  firstId: string;
  windowEnd: Date;
  count: number;
}

/**
 * D-20: `attempts` failures inside one `windowMinutes` window. Bursts are
 * found greedily and do not overlap, so a long attack yields one alert per
 * `attempts` failures rather than one per attempt.
 */
export function failedLoginBursts(events: FailedAttempt[], attempts: number, windowMinutes: number): FailedLoginBurst[] {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const span = windowMinutes * 60_000;
  const out: FailedLoginBurst[] = [];
  let i = 0;
  while (i + attempts - 1 < sorted.length) {
    const last = sorted[i + attempts - 1];
    if (last.at.getTime() - sorted[i].at.getTime() <= span) {
      out.push({ firstId: sorted[i].id, windowEnd: last.at, count: attempts });
      i += attempts;
    } else {
      i++;
    }
  }
  return out;
}

/** "jane.doe@gmail.com" → "j***@gmail.com" — enough for the admin to recognise, never the full address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
