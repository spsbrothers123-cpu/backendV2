import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { Role } from "@prisma/client";

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
  jti: string;
}

export function signAccessToken(userId: string, role: Role): { token: string; jti: string } {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, role, jti } satisfies AccessTokenPayload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
  return { token, jti };
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
}

/** Converts a JWT_EXPIRES_IN-style string ("12h", "30m", "7d") to a Date. */
export function expiresInToDate(expiresIn: string): Date {
  const match = /^(\d+)([smhd])$/.exec(expiresIn.trim());
  if (!match) {
    // Fallback: treat unparsable values as 12h so a session record is
    // always created with a sane expiry rather than throwing.
    return new Date(Date.now() + 12 * 60 * 60 * 1000);
  }
  const [, amountStr, unit] = match;
  const amount = Number(amountStr);
  const unitMs: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return new Date(Date.now() + amount * unitMs[unit]);
}
