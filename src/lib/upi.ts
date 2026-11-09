/**
 * UPI Management — configuration rules and receiver resolution.
 *
 * Scope of this module (Phase 3, Admin configuration only): validating and
 * normalizing the receiving-account details an Admin saves, and resolving
 * which account is the "effective" receiver for a shop.
 *
 * Nothing here records, confirms or verifies a payment. Format validation
 * does NOT prove that a UPI account exists or who owns it.
 */

// Same rules the Admin frontend applies (src/lib/upiValidation.ts). The
// backend is the authority; the frontend copy is UX only.
const UPI_ID_RE = /^[A-Za-z0-9._-]{2,256}@[A-Za-z]{2,64}$/;
// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/;

export const PAYEE_NAME_MIN = 2;
export const PAYEE_NAME_MAX = 50;

/** Trimmed and lower-cased — UPI IDs are compared case-insensitively. */
export function normalizeUpiId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function normalizePayeeName(raw: string): string {
  return raw.trim();
}

/** Returns an error message, or null when the UPI ID is acceptable. */
export function validateUpiId(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "UPI ID is required.";
  if (!UPI_ID_RE.test(value)) {
    return "Enter a UPI ID like name@provider (letters, numbers, dot, hyphen or underscore before the @).";
  }
  return null;
}

/** Returns an error message, or null when the payee name is acceptable. */
export function validatePayeeName(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Payee name is required.";
  if (value.length < PAYEE_NAME_MIN) return `Payee name must be at least ${PAYEE_NAME_MIN} characters.`;
  if (value.length > PAYEE_NAME_MAX) return `Payee name must be at most ${PAYEE_NAME_MAX} characters.`;
  if (CONTROL_CHARS_RE.test(value)) return "Payee name contains invalid characters.";
  return null;
}

/** "ab***@okbank" — for audit metadata, so logs never carry a full UPI ID. */
export function maskUpiId(upiId: string): string {
  const at = upiId.lastIndexOf("@");
  if (at < 1) return "***";
  return `${upiId.slice(0, Math.min(2, at))}***${upiId.slice(at)}`;
}

// ── Receiver resolution ─────────────────────────────────────────────────

export type UpiReceiverSource = "SHOP" | "COMMON" | "NONE";

export interface UpiCommonAccountData {
  upiId: string;
  payeeName: string;
  enabled: boolean;
}

export interface UpiShopAccountData {
  mode: "COMMON" | "CUSTOM";
  customUpiId: string | null;
  customPayeeName: string | null;
  customEnabled: boolean;
}

export interface EffectiveReceiver {
  source: UpiReceiverSource;
  upiId: string | null;
  payeeName: string | null;
  /** Human-readable explanation when the result isn't the plain case. */
  reason: string | null;
}

function usable(upiId: string | null | undefined, payeeName: string | null | undefined): boolean {
  return (
    upiId != null &&
    payeeName != null &&
    validateUpiId(upiId) === null &&
    validatePayeeName(payeeName) === null
  );
}

/**
 * Pure resolver, shared by the Admin overview now and by the Cashier QR
 * endpoint later, so both always agree on the receiving account.
 *
 * Priority (spec §3):
 *   1. Enabled custom shop account (only when mode = CUSTOM).
 *   2. Enabled common Admin account.
 *   3. None.
 *
 * Custom details saved while mode = COMMON are dormant and never used.
 */
export function resolveEffectiveReceiver(
  common: UpiCommonAccountData | null,
  shop: UpiShopAccountData | null
): EffectiveReceiver {
  const customSelected = shop?.mode === "CUSTOM";

  if (customSelected && shop!.customEnabled && usable(shop!.customUpiId, shop!.customPayeeName)) {
    return {
      source: "SHOP",
      upiId: normalizeUpiId(shop!.customUpiId!),
      payeeName: normalizePayeeName(shop!.customPayeeName!),
      reason: null,
    };
  }

  const commonUsable = common != null && common.enabled && usable(common.upiId, common.payeeName);

  if (commonUsable) {
    let reason: string | null = null;
    if (customSelected) {
      reason = !shop!.customEnabled
        ? "This shop's custom account is disabled, so the common account is used."
        : "This shop's custom account is incomplete, so the common account is used.";
    }
    return {
      source: "COMMON",
      upiId: normalizeUpiId(common!.upiId),
      payeeName: normalizePayeeName(common!.payeeName),
      reason,
    };
  }

  let reason: string;
  if (customSelected && !shop!.customEnabled) {
    reason = common
      ? "This shop's custom account is disabled and the common account is not available."
      : "This shop's custom account is disabled and no common account is set.";
  } else if (common && !common.enabled) {
    reason = "The common account is disabled.";
  } else if (customSelected) {
    reason = "This shop's custom account is incomplete and no common account is set.";
  } else {
    reason = "No UPI account is configured.";
  }
  return { source: "NONE", upiId: null, payeeName: null, reason };
}
