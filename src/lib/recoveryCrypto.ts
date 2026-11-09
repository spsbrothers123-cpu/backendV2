import { createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Pure (no database) cryptographic helpers for Admin password recovery.
 * Everything here is deterministic given its inputs + the pepper, which is
 * what makes it unit-testable without a database.
 *
 * ── Recovery codes ─────────────────────────────────────────────────────
 * A code is 20 random bytes (160 bits — comfortably above the 128-bit
 * minimum) from crypto.randomBytes, encoded as 32 Crockford-base32
 * characters (exactly 5 bits each, so there are no padding bits and no
 * modulo bias) and shown grouped as XXXX-XXXX-…-XXXX.
 *
 * At rest we store HMAC-SHA256(pepper, "recovery-code:v1:<userId>:<code>").
 *  - Keyed: a database leak alone cannot be used to test guesses.
 *  - Bound to userId: a hash is only ever valid for one account, so a code
 *    can never be redeemed against a different account (cross-account
 *    recovery), and identical codes would still hash differently.
 *  - A fast keyed hash (not bcrypt) is the right tool here: the input is
 *    160 bits of uniform randomness, so slowing the hash adds nothing,
 *    while it keeps verification cheap enough to be a DoS non-issue.
 */

export const RECOVERY_CODE_BYTES = 20;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U
const CODE_CHARS = (RECOVERY_CODE_BYTES * 8) / 5; // 32
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{32}$/;
/** Anything longer than this is rejected before any hashing work. */
const MAX_CODE_INPUT_LENGTH = 64;

/** Encodes bytes as Crockford base32 (no padding; caller supplies a multiple of 5 bytes). */
export function encodeCrockford(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // keep only the not-yet-emitted bits
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** One new recovery code in display form, e.g. "7K3M-…-9ZQ4". */
export function generateRecoveryCode(): string {
  const raw = encodeCrockford(randomBytes(RECOVERY_CODE_BYTES));
  return raw.match(/.{4}/g)!.join("-");
}

/**
 * Canonical form used for hashing: upper-case, separators removed, and the
 * Crockford look-alike substitutions applied (O→0, I/L→1) so a code typed
 * from a printout still matches. Returns null for anything that cannot be
 * a valid code (wrong length/alphabet, non-string, absurdly long input).
 */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > MAX_CODE_INPUT_LENGTH) return null;
  const canonical = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return canonical.length === CODE_CHARS && CODE_PATTERN.test(canonical) ? canonical : null;
}

/**
 * Validates the pepper. Fails CLOSED: with no (or a too-short) pepper no
 * recovery code can be hashed, so the recovery feature is unusable rather
 * than silently insecure. Exported so it can be tested without reloading
 * the env module.
 */
export function requirePepper(pepper: string | undefined): string {
  if (!pepper || pepper.length < 32) {
    throw new Error("RECOVERY_CODE_PEPPER is not configured (it must be set to at least 32 characters).");
  }
  return pepper;
}

function getPepper(): string {
  return requirePepper(env.RECOVERY_CODE_PEPPER);
}

function hmacHex(pepper: string, message: string): string {
  return createHmac("sha256", pepper).update(message, "utf8").digest("hex");
}

/** Keyed hash stored in admin_recovery_codes.codeHash. `normalizedCode` must come from normalizeRecoveryCode(). */
export function hashRecoveryCode(userId: string, normalizedCode: string, pepper: string = getPepper()): string {
  return hmacHex(pepper, `recovery-code:v1:${userId}:${normalizedCode}`);
}

/**
 * Keyed hash of an email, used as the throttle/audit key for recovery
 * attempts. Known and unknown emails go through exactly the same function,
 * so throttling behaves identically for both (no enumeration), and the raw
 * email is never written to the recovery audit table.
 */
export function hashRecoverySubject(email: string, pepper: string = getPepper()): string {
  return hmacHex(pepper, `recovery-subject:v1:${email.trim().toLowerCase().slice(0, 320)}`);
}

// ── Recovery grant tokens ──────────────────────────────────────────────
// 256-bit random opaque token. Because it is already uniformly random, a
// plain SHA-256 is sufficient for storage (nothing to brute-force).

const GRANT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateGrantToken(): string {
  return randomBytes(32).toString("base64url"); // 43 chars
}

export function isWellFormedGrantToken(token: unknown): token is string {
  return typeof token === "string" && GRANT_TOKEN_PATTERN.test(token);
}

export function hashGrantToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A grant is bound to the User-Agent it was issued to (hijack mitigation). A missing UA hashes as "". */
export function hashUserAgent(userAgent: string | null | undefined): string {
  return createHash("sha256")
    .update((userAgent ?? "").slice(0, 512), "utf8")
    .digest("hex");
}
