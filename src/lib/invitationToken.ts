import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/**
 * Short-lived, single-purpose token proving a cashier already presented a
 * valid invitation code. Issued by POST /auth/signup/verify-invitation,
 * consumed by POST /auth/signup. Signed with the backend's JWT secret —
 * never the invitation code itself (see Backend spec §10) — so it can't be
 * forged, and it carries `purpose` so it can never be reused as (or
 * confused with) a normal access token.
 *
 * RBR Egg Mart V2 Phase 1: no longer carries a shopId. An invitation code
 * is not tied to any shop — the shop is resolved at signup time from the
 * cashier's own Branch Name (see src/lib/shopAccess.ts
 * resolveOrCreateShopByLocation), not from the invitation.
 */
const PURPOSE = "CASHIER_SIGNUP_INVITATION" as const;

export interface InvitationTokenPayload {
  invitationId: string;
  purpose: typeof PURPOSE;
}

export function signInvitationToken(invitationId: string): string {
  return jwt.sign({ invitationId, purpose: PURPOSE } satisfies InvitationTokenPayload, env.JWT_SECRET, {
    expiresIn: `${env.INVITATION_TOKEN_EXPIRY_MINUTES}m`,
  });
}

export type InvitationTokenError = "EXPIRED" | "INVALID";

/** Returns the verified payload, or throws a plain "EXPIRED" | "INVALID"
 * string so callers can map it to the right API error code without having
 * to inspect jsonwebtoken's exception classes themselves. */
export function verifyInvitationToken(token: string): InvitationTokenPayload {
  let payload: unknown;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw "EXPIRED" satisfies InvitationTokenError;
    }
    throw "INVALID" satisfies InvitationTokenError;
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as Record<string, unknown>).purpose !== PURPOSE ||
    typeof (payload as Record<string, unknown>).invitationId !== "string"
  ) {
    throw "INVALID" satisfies InvitationTokenError;
  }

  return payload as InvitationTokenPayload;
}
