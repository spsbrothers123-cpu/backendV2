import type { NtfCategory, NtfSeverity } from "@prisma/client";

export type Audience = "ADMIN" | "CASHIER";

/** Centralized business rules (D-17, D-19, D-20, D-22, D-10). Do not duplicate elsewhere. */
export const NOTIFICATION_DEFAULTS = {
  /** D-19: sale total >= this raises a high-value alert. */
  highValueSaleThreshold: 5000,
  /** D-19: credit portion of a bill >= this raises a large-credit alert. */
  largeCreditThreshold: 10000,
  /** D-19: zero tolerance — any non-zero difference. */
  cashMismatchTolerance: 0,
  /**
   * ASSUMPTION (not in the decision register): D-15 gates due dates, so "overdue"
   * is age-based — oldest unpaid credit charge older than N days. Branch-overridable.
   */
  creditOverdueDays: 30,
  /** D-20 */
  failedLogin: { attempts: 5, windowMinutes: 10 },
  /** D-10 */
  retentionDays: 90,
  /** Reminders fire within this many minutes after the configured time (catch-up window). */
  reminderGraceMinutes: 120,
  /** Sweeps re-read this far behind their watermark; dedupe keys make the overlap free. */
  sweepOverlapMs: 5 * 60_000,
  /** First-ever sweep looks back this far (no historical flood). */
  initialLookbackMs: 60 * 60_000,
  /** Daily summary schedule in IST minutes-of-day (D-22). */
  summary: { mainAtMinutes: 22 * 60, supplementaryAtMinutes: 5 },
} as const;

// ── Audience-specific category slugs (D-03: shared internal names, mapped per audience) ──
export const ADMIN_CATEGORY_SLUG: Partial<Record<NtfCategory, string>> = {
  INVENTORY: "inventory",
  CASHIER: "cashier",
  CREDIT: "credit",
  SALES_PURCHASES: "sales_purchases",
  SECURITY: "security",
  DAILY_SUMMARY: "daily_summary",
};
export const CASHIER_CATEGORY_SLUG: Partial<Record<NtfCategory, string>> = {
  INVENTORY: "inventory",
  ACCOUNT_SECURITY: "account_security",
  SESSION: "session",
  ANNOUNCEMENT: "announcement",
  CREDIT: "credit",
};

/** Display order of the configurable categories per audience. */
export const ADMIN_CATEGORIES: NtfCategory[] = ["INVENTORY", "CASHIER", "CREDIT", "SALES_PURCHASES", "SECURITY", "DAILY_SUMMARY"];
export const CASHIER_CATEGORIES: NtfCategory[] = ["INVENTORY", "ACCOUNT_SECURITY", "SESSION", "ANNOUNCEMENT", "CREDIT"];

export const AUDIENCE_CATEGORIES: Record<Audience, NtfCategory[]> = {
  ADMIN: ADMIN_CATEGORIES,
  CASHIER: CASHIER_CATEGORIES,
};

/** D-07 / D-27: permanently ON, never deletable. */
export const LOCKED_CATEGORIES: ReadonlySet<NtfCategory> = new Set<NtfCategory>(["SECURITY", "ACCOUNT_SECURITY"]);

export function categorySlug(audience: Audience, category: NtfCategory): string | undefined {
  return (audience === "ADMIN" ? ADMIN_CATEGORY_SLUG : CASHIER_CATEGORY_SLUG)[category];
}

export function categoryFromSlug(audience: Audience, slug: string): NtfCategory | undefined {
  const table = audience === "ADMIN" ? ADMIN_CATEGORY_SLUG : CASHIER_CATEGORY_SLUG;
  return (Object.entries(table).find(([, s]) => s === slug)?.[0]) as NtfCategory | undefined;
}

// ── Canonical event types ────────────────────────────────────────────
export interface TypeDef {
  admin?: { category: NtfCategory; severity: NtfSeverity };
  cashier?: { category: NtfCategory; severity: NtfSeverity; apiType: string };
}

export const TYPES = {
  "inventory.low_stock": {
    admin: { category: "INVENTORY", severity: "WARNING" },
    cashier: { category: "INVENTORY", severity: "WARNING", apiType: "low_stock" },
  },
  "inventory.out_of_stock": {
    admin: { category: "INVENTORY", severity: "CRITICAL" },
    cashier: { category: "INVENTORY", severity: "CRITICAL", apiType: "out_of_stock" },
  },
  "inventory.restocked": {
    admin: { category: "INVENTORY", severity: "INFO" },
    cashier: { category: "INVENTORY", severity: "INFO", apiType: "restocked" },
  },
  "sales.high_value": { admin: { category: "SALES_PURCHASES", severity: "INFO" } },
  "credit.large_sale": { admin: { category: "CREDIT", severity: "WARNING" } },
  "credit.overdue": {
    admin: { category: "CREDIT", severity: "WARNING" },
    cashier: { category: "CREDIT", severity: "WARNING", apiType: "credit_overdue" },
  },
  "credit.adjusted": {
    admin: { category: "CREDIT", severity: "WARNING" },
    cashier: { category: "CREDIT", severity: "INFO", apiType: "credit_adjusted" },
  },
  "credit.cleared": {
    admin: { category: "CREDIT", severity: "INFO" },
    cashier: { category: "CREDIT", severity: "INFO", apiType: "credit_cleared" },
  },
  "session.opened": {
    admin: { category: "CASHIER", severity: "INFO" },
    cashier: { category: "SESSION", severity: "INFO", apiType: "session_opened" },
  },
  "session.closed": {
    admin: { category: "CASHIER", severity: "INFO" },
    cashier: { category: "SESSION", severity: "INFO", apiType: "session_closed" },
  },
  "cash.mismatch": {
    admin: { category: "CASHIER", severity: "CRITICAL" },
    cashier: { category: "SESSION", severity: "CRITICAL", apiType: "cash_mismatch" },
  },
  "reminder.opening": { cashier: { category: "SESSION", severity: "INFO", apiType: "opening_reminder" } },
  "reminder.closing": { cashier: { category: "SESSION", severity: "INFO", apiType: "closing_reminder" } },
  "security.failed_login": { admin: { category: "SECURITY", severity: "CRITICAL" } },
  "security.admin_password_recovered": { admin: { category: "SECURITY", severity: "CRITICAL" } },
  "security.cashier_recovery_requested": { admin: { category: "SECURITY", severity: "WARNING" } },
  "account.cashier_signup_pending": { admin: { category: "CASHIER", severity: "INFO" } },
  "account.password_changed": { cashier: { category: "ACCOUNT_SECURITY", severity: "WARNING", apiType: "password_changed" } },
  "account.changed": { cashier: { category: "ACCOUNT_SECURITY", severity: "INFO", apiType: "account_changed" } },
  "account.recovery_status": { cashier: { category: "ACCOUNT_SECURITY", severity: "INFO", apiType: "recovery_status" } },
  "announcement.published": { cashier: { category: "ANNOUNCEMENT", severity: "INFO", apiType: "announcement" } },
  "summary.daily": { admin: { category: "DAILY_SUMMARY", severity: "INFO" } },
} as const satisfies Record<string, TypeDef>;

export type NotificationTypeKey = keyof typeof TYPES;

export function typeDef(type: string): TypeDef | undefined {
  return (TYPES as Record<string, TypeDef>)[type];
}

/** Admin API `type` values are the canonical dotted names. Cashier API uses the mapped short names. */
export function cashierApiType(type: string): string {
  return typeDef(type)?.cashier?.apiType ?? type.split(".").pop() ?? type;
}
