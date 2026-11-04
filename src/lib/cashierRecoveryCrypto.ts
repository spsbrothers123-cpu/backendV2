import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { generateRecoveryCode, normalizeRecoveryCode, requirePepper } from "./recoveryCrypto.js";

/**
 * Cryptographic helpers for Cashier admin-assisted recovery.
 *
 * Codes reuse the Admin recovery format (20 random bytes = 160 bits from
 * crypto.randomBytes, Crockford base32, grouped XXXX-…-XXXX) — comfortably
 * above the required 128 bits. The stored value is a DIFFERENT keyed hash:
 *
 *   HMAC-SHA256(pepper, "cashier-recovery-code:v1:<requestId>:<userId>:<code>")
 *
 * - Keyed with RECOVERY_CODE_PEPPER: a database leak alone can't confirm guesses.
 * - Domain-separated ("cashier-recovery-code:v1") from admin recovery codes.
 * - Bound to the request AND the user: a code only ever works for the single
 *   request it was issued for, never another request or account.
 */

export function generateCashierRecoveryCode(): string {
  return generateRecoveryCode();
}

/** Canonical form, or null if the input cannot be a valid code (wrong length/alphabet/too long). */
export function normalizeCashierRecoveryCode(input: unknown): string | null {
  return normalizeRecoveryCode(input);
}

export function hashCashierRecoveryCode(
  requestId: string,
  userId: string,
  normalizedCode: string,
  pepper: string = requirePepper(env.RECOVERY_CODE_PEPPER)
): string {
  return createHmac("sha256", pepper)
    .update(`cashier-recovery-code:v1:${requestId}:${userId}:${normalizedCode}`, "utf8")
    .digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
