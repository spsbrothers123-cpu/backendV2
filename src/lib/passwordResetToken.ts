import crypto from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/**
 * Short-lived, single-purpose token proving a user requested a password
 * reset for a specific account. Issued by POST /auth/forgot-password,
 * consumed by POST /auth/reset-password. Signed with the backend's JWT
 * secret (same approach as lib/invitationToken.ts), never stored anywhere
 * — nothing here requires a schema change.
 *
 * `pwFingerprint` is a short hash of the user's CURRENT passwordHash at
 * the moment the token was issued. Verifying it against the user's
 * passwordHash at reset time gives single-use behavior for free: the
 * moment the password actually changes (via this reset, or any other
 * path), every previously-issued token for that user stops matching and
 * is rejected — without needing a "used tokens" table.
 */
const PURPOSE = "PASSWORD_RESET" as const;

export interface PasswordResetTokenPayload {
  userId: string;
  purpose: typeof PURPOSE;
  pwFingerprint: string;
}

export function passwordFingerprint(passwordHash: string): string {
  return crypto.createHash("sha256").update(passwordHash).digest("hex").slice(0, 16);
}

export function signPasswordResetToken(userId: string, currentPasswordHash: string): string {
  return jwt.sign(
    { userId, purpose: PURPOSE, pwFingerprint: passwordFingerprint(currentPasswordHash) } satisfies PasswordResetTokenPayload,
    env.JWT_SECRET,
    { expiresIn: `${env.PASSWORD_RESET_TOKEN_EXPIRY_MINUTES}m` }
  );
}

export type PasswordResetTokenError = "EXPIRED" | "INVALID";

/** Returns the verified payload, or throws a plain "EXPIRED" | "INVALID"
 * string, same convention as verifyInvitationToken(). */
export function verifyPasswordResetToken(token: string): PasswordResetTokenPayload {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw "EXPIRED" satisfies PasswordResetTokenError;
    }
    throw "INVALID" satisfies PasswordResetTokenError;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as Record<string, unknown>).purpose !== PURPOSE ||
    typeof (payload as Record<string, unknown>).userId !== "string" ||
    typeof (payload as Record<string, unknown>).pwFingerprint !== "string"
  ) {
    throw "INVALID" satisfies PasswordResetTokenError;
  }

  return payload as PasswordResetTokenPayload;
}
