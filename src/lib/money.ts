import { Decimal } from "@prisma/client/runtime/library.js";

/**
 * All persisted financial values are PostgreSQL NUMERIC/DECIMAL, mapped by
 * Prisma to Decimal (re-exported by Prisma as Prisma.Decimal, but imported
 * directly from the runtime here — see note in README/PR: this only needs
 * the runtime library, not a fully-generated client). This file is the
 * ONLY place that converts between Decimal and JS number — every
 * route/service should go through these helpers rather than doing
 * arithmetic on `.toNumber()` results directly, so precision loss can't
 * creep in silently.
 */

export type Money = Decimal;

export function toDecimal(value: number | string | Money): Money {
  return new Decimal(value as never);
}

export const ZERO = new Decimal(0);

export function add(...values: Money[]): Money {
  return values.reduce((sum, v) => sum.plus(v), ZERO);
}

export function sub(a: Money, b: Money): Money {
  return a.minus(b);
}

export function mul(a: Money, b: number): Money {
  return a.times(b);
}

/** Rounds to 2dp using standard half-up rounding, as currency requires. */
export function round2(value: Money): Money {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** For JSON responses only — never for further arithmetic. */
export function toNumber(value: Money | null | undefined): number {
  if (value == null) return 0;
  return Number(value.toFixed(2));
}

/** Compares two money values for exact equality at 2dp (used for the
 * "split payments must sum exactly to bill total" rule). */
export function equalsMoney(a: Money, b: Money): boolean {
  return round2(a).equals(round2(b));
}
