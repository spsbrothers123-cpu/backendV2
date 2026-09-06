import { randomInt, createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";

const CODE_LENGTH = 6;

/**
 * Generates a cryptographically secure 6-digit numeric invitation code
 * using Node's crypto.randomInt (never Math.random, never a timestamp —
 * see Backend spec §3). Zero-padded so leading zeros are preserved
 * (e.g. "032914").
 */
export function generateInvitationCode(): string {
  const max = 10 ** CODE_LENGTH;
  const value = randomInt(0, max);
  return value.toString().padStart(CODE_LENGTH, "0");
}

// Invitation codes are short-lived, single-purpose numeric codes — SHA-256
// is sufficient (and lets validation look a candidate row up directly by
// hash, since there's no requestId to key off of the way OTP verification
// used to) unlike passwords, which use bcrypt in lib/password.ts.
export function hashInvitationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function invitationCodeMatches(code: string, hash: string): boolean {
  const candidate = Buffer.from(hashInvitationCode(code), "hex");
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

export function invitationCodeExpiryDate(): Date {
  return new Date(Date.now() + env.INVITATION_CODE_EXPIRY_MINUTES * 60 * 1000);
}

/** "482731" -> "••••31" — the only form of a used/expired/revoked code that
 * is ever retained or displayed anywhere (Admin cashier-requests list). */
export function maskInvitationCode(code: string): string {
  return `••••${code.slice(-2)}`;
}
