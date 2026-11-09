import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import type { AdminRecoveryMethod } from "@prisma/client";
import { prisma } from "./prisma.js";
import { AppError, Errors } from "./errors.js";
import { hashPassword, isPasswordStrongEnough } from "./password.js";
import { recordAudit } from "./audit.js";
import { sendAdminPasswordRecovered } from "./email.js";
import { consumeRecoveryCode } from "./recoveryCodes.js";
import {
  consumeRecoveryGrant,
  invalidateOutstandingGrants,
  issueRecoveryGrant,
} from "./recoveryGrant.js";
import { recordRecoveryAudit } from "./recoveryAudit.js";
import {
  hashGrantToken,
  hashRecoverySubject,
  hashUserAgent,
  isWellFormedGrantToken,
  requirePepper,
} from "./recoveryCrypto.js";
import {
  checkRecoveryThrottle,
  recordFailedCodeVerification,
  recordFailedPasskeyVerification,
  recordThrottledAttempt,
} from "./recoveryThrottle.js";
import { getWebAuthnConfig, verifyPasskeyAuthentication, type WebAuthnConfig } from "./webauthn.js";
import { env } from "../config/env.js";

/**
 * Admin Forgot Password (Phase 3).
 *
 * The flow has three server-verified steps, and the password can only be
 * changed by the third:
 *
 *   1. PROVE ownership with a recovery credential
 *        - emergency recovery code  → verifyRecoveryCode()
 *        - registered passkey       → createPasskeyAuthenticationOptions()
 *                                      + verifyPasskeyRecovery()
 *      Success consumes the credential and issues a recovery GRANT
 *      (lib/recoveryGrant.ts): opaque, single-use, short-lived, bound to
 *      one account and to the requesting User-Agent.
 *   2. REDEEM the grant → resetPasswordWithGrant(). The request carries NO
 *      email or user id: the account is whatever the grant was issued to, so
 *      verification and password update cannot be pointed at different
 *      accounts.
 *   3. The password hash, session revocation, grant invalidation and audit
 *      row commit in ONE transaction.
 *
 * NOTE ON SUPABASE: this codebase has no Supabase Auth (Supabase is only the
 * hosted Postgres). Accounts live in the `users` table with a bcrypt hash and
 * sessions in the `sessions` table, so "update the password" and "revoke
 * sessions" are done there. Because plugins/auth.ts checks the session row on
 * EVERY request, revoking a row kills an already-issued JWT immediately —
 * there is no residual validity window to account for.
 */

export interface RecoveryContext {
  ip?: string | null;
  userAgent?: string | null;
}

export const RECOVERY_CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_LIVE_CHALLENGES_PER_SUBJECT = 10;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The ONE error for every verification failure — unknown email, non-admin,
 * suspended, no such method configured, wrong/used/revoked code, bad
 * signature, wrong challenge. Callers must never vary it.
 */
const verificationFailed = () =>
  new AppError(400, "RECOVERY_VERIFICATION_FAILED", "We couldn't verify that. Check your details and try again.");

const invalidGrant = () =>
  new AppError(400, "RECOVERY_GRANT_INVALID", "This recovery session is invalid or has expired. Please start again.");

/** Fails closed (503) when the server cannot hash/throttle recovery attempts. Identical for every caller. */
export function requireRecoveryConfigured(): void {
  try {
    requirePepper(env.RECOVERY_CODE_PEPPER);
  } catch {
    throw new AppError(503, "RECOVERY_NOT_CONFIGURED", "Account recovery is not available on this server yet.");
  }
}

function requirePasskeyConfig(): WebAuthnConfig {
  const config = getWebAuthnConfig();
  if (!config) {
    throw new AppError(
      503,
      "PASSKEYS_NOT_CONFIGURED",
      "Passkeys are not available on this server yet. You can use a recovery code instead."
    );
  }
  return config;
}

async function enforceThrottle(subjectHash: string, ctx: RecoveryContext, method: AdminRecoveryMethod) {
  const decision = await checkRecoveryThrottle({ subjectHash, ip: ctx.ip });
  if (!decision.blocked) return;
  await recordThrottledAttempt(
    { subjectHash, ip: ctx.ip, userAgent: ctx.userAgent },
    decision,
    prisma,
    method
  );
  throw new AppError(
    429,
    "RECOVERY_THROTTLED",
    `Too many attempts. Please try again in ${decision.retryAfterSeconds} seconds.`
  );
}

/** Same lookup rules as POST /auth/admin/login (exact, trimmed email), plus ADMIN + ACTIVE. */
async function findEligibleAdmin(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  return user && user.role === "ADMIN" && user.status === "ACTIVE" ? user : null;
}

export interface IssuedGrantResponse {
  grantToken: string;
  expiresAt: string;
}

// ── Method 1: emergency recovery code ───────────────────────────────────

export async function verifyRecoveryCode(input: {
  email: string;
  code: unknown;
  ctx: RecoveryContext;
}): Promise<IssuedGrantResponse> {
  requireRecoveryConfigured();
  const { ctx } = input;
  const subjectHash = hashRecoverySubject(input.email);
  await enforceThrottle(subjectHash, ctx, "RECOVERY_CODE");

  const admin = await findEligibleAdmin(input.email);

  // Unknown / ineligible accounts run the SAME conditional UPDATE (against a
  // nil id that matches nothing), so both paths cost the same database work.
  const grant = await prisma.$transaction(async (tx) => {
    const consumed = await consumeRecoveryCode(admin?.id ?? NIL_UUID, input.code, tx);
    if (!admin || !consumed) return null;

    const issued = await issueRecoveryGrant(
      { userId: admin.id, method: "RECOVERY_CODE", userAgent: ctx.userAgent },
      tx
    );
    const base = { userId: admin.id, method: "RECOVERY_CODE" as const, ip: ctx.ip, userAgent: ctx.userAgent };
    await recordRecoveryAudit({ ...base, subjectHash, event: "CODE_VERIFICATION", outcome: "SUCCESS" }, tx);
    await recordRecoveryAudit({ ...base, event: "GRANT_ISSUED", outcome: "SUCCESS" }, tx);
    return issued;
  });

  if (!grant) {
    await recordFailedCodeVerification({
      userId: admin?.id ?? null,
      subjectHash,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw verificationFailed();
  }
  return { grantToken: grant.token, expiresAt: grant.expiresAt.toISOString() };
}

// ── Method 2: passkey (WebAuthn authentication ceremony) ────────────────

/**
 * Issues a WebAuthn challenge. The response is IDENTICAL for known and
 * unknown emails and for Admins with or without passkeys: it uses the
 * discoverable-credential flow (no allowCredentials), so nothing in it
 * depends on the account. The email is used only to bind the challenge
 * (as a keyed hash) so it cannot be redeemed for a different email.
 */
export async function createPasskeyAuthenticationOptions(input: {
  email: string;
  ctx: RecoveryContext;
}): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  requireRecoveryConfigured();
  const config = requirePasskeyConfig();
  const subjectHash = hashRecoverySubject(input.email);

  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    userVerification: "required",
    timeout: 60_000,
  });

  const challengeId = randomUUID();
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.adminRecoveryChallenge.create({
      data: {
        id: challengeId,
        subjectHash,
        userAgentHash: hashUserAgent(input.ctx.userAgent),
        challenge: options.challenge,
        expiresAt: new Date(now.getTime() + RECOVERY_CHALLENGE_TTL_MS),
      },
    });
    // Bound table growth: cap live challenges per email, drop old expired ones.
    const surplus = await tx.adminRecoveryChallenge.findMany({
      where: { subjectHash, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      skip: MAX_LIVE_CHALLENGES_PER_SUBJECT,
      select: { id: true },
    });
    if (surplus.length > 0) {
      await tx.adminRecoveryChallenge.deleteMany({ where: { id: { in: surplus.map((c) => c.id) } } });
    }
    await tx.adminRecoveryChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 60 * 60_000) } },
    });
  });

  return { challengeId, options };
}

export async function verifyPasskeyRecovery(input: {
  email: string;
  challengeId: string;
  response: AuthenticationResponseJSON;
  ctx: RecoveryContext;
}): Promise<IssuedGrantResponse> {
  requireRecoveryConfigured();
  const config = requirePasskeyConfig();
  const { ctx } = input;
  const subjectHash = hashRecoverySubject(input.email);
  await enforceThrottle(subjectHash, ctx, "PASSKEY");

  const now = new Date();
  let adminId: string | null = null;

  try {
    // Atomic single-use claim, bound to this email AND this client. It is
    // consumed BEFORE verification, so a challenge can never be tried twice.
    const claimed = await prisma.adminRecoveryChallenge.updateMany({
      where: {
        id: input.challengeId,
        subjectHash,
        userAgentHash: hashUserAgent(ctx.userAgent),
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) throw new Error("challenge invalid");

    const challenge = await prisma.adminRecoveryChallenge.findUniqueOrThrow({
      where: { id: input.challengeId },
      select: { challenge: true },
    });

    const admin = await findEligibleAdmin(input.email);
    if (!admin) throw new Error("no eligible admin");
    adminId = admin.id;

    // Cross-account binding: the credential must belong to the account whose
    // email was submitted, not merely to "some Admin".
    const passkey = await prisma.adminPasskey.findUnique({ where: { credentialId: input.response.id } });
    if (!passkey || passkey.userId !== admin.id) throw new Error("credential not owned by account");

    const userHandle = input.response.response.userHandle;
    if (userHandle && userHandle !== passkey.userHandle) throw new Error("user handle mismatch");

    const { newCounter } = await verifyPasskeyAuthentication({
      response: input.response,
      expectedChallenge: challenge.challenge,
      config,
      credential: {
        id: passkey.credentialId,
        publicKey: passkey.publicKey,
        counter: Number(passkey.counter),
        transports: passkey.transports,
      },
    });

    const issued = await prisma.$transaction(async (tx) => {
      // Compare-and-set on the counter: two concurrent assertions can't both
      // advance it, and a replayed/cloned authenticator loses the race.
      const advanced = await tx.adminPasskey.updateMany({
        where: { id: passkey.id, counter: passkey.counter },
        data: { counter: newCounter, lastUsedAt: now },
      });
      if (advanced.count !== 1) throw new Error("counter race");

      const grant = await issueRecoveryGrant(
        { userId: admin.id, method: "PASSKEY", userAgent: ctx.userAgent },
        tx
      );
      const base = { userId: admin.id, method: "PASSKEY" as const, ip: ctx.ip, userAgent: ctx.userAgent };
      await recordRecoveryAudit({ ...base, subjectHash, event: "PASSKEY_VERIFICATION", outcome: "SUCCESS" }, tx);
      await recordRecoveryAudit({ ...base, event: "GRANT_ISSUED", outcome: "SUCCESS" }, tx);
      return grant;
    });

    return { grantToken: issued.token, expiresAt: issued.expiresAt.toISOString() };
  } catch {
    await recordFailedPasskeyVerification({
      userId: adminId,
      subjectHash,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    throw verificationFailed();
  }
}

// ── Step 3: set the new password with a grant ───────────────────────────

export async function resetPasswordWithGrant(input: {
  grantToken: unknown;
  newPassword: string;
  ctx: RecoveryContext;
}): Promise<{ userId: string; notified: boolean }> {
  const { ctx } = input;

  // Cheap checks first, BEFORE the grant is consumed: a malformed token costs
  // nothing, and a weak password doesn't burn a legitimate admin's grant.
  if (!isWellFormedGrantToken(input.grantToken)) throw invalidGrant();
  if (!isPasswordStrongEnough(input.newPassword)) {
    throw Errors.validation("Password must be at least 8 characters and include a letter and a number.");
  }

  // An unauthenticated caller must not be able to make the server spend a
  // bcrypt round on every request: only do that work for a grant that
  // currently exists, is unconsumed and unexpired. (Advisory only — the
  // atomic claim inside the transaction below is what actually decides.)
  const known = await prisma.adminRecoveryGrant.findUnique({
    where: { tokenHash: hashGrantToken(input.grantToken) },
    select: { consumedAt: true, expiresAt: true },
  });
  if (!known || known.consumedAt || known.expiresAt <= new Date()) throw invalidGrant();

  // Slow bcrypt work stays outside the transaction.
  const passwordHash = await hashPassword(input.newPassword);

  const outcome = await prisma.$transaction(async (tx) => {
    // Atomic single-use redemption, bound to the issuing User-Agent. The
    // account comes from the grant row — never from the request.
    const grant = await consumeRecoveryGrant({ token: input.grantToken, userAgent: ctx.userAgent }, tx);
    if (!grant) throw invalidGrant();

    // Serialise with other writers to this account and re-check eligibility
    // on the locked row (role/status may have changed since the grant).
    const locked = await tx.$queryRaw<Array<{ role: string; status: string; shopId: string | null }>>`
      SELECT "role"::text AS role, "status"::text AS status, "shopId" AS "shopId"
      FROM "users" WHERE "id" = ${grant.userId} FOR UPDATE`;
    const user = locked[0];
    if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE") throw invalidGrant();

    await tx.user.update({ where: { id: grant.userId }, data: { passwordHash } });

    // Kill every session. plugins/auth.ts re-reads the session row on every
    // request, so already-issued JWTs stop working immediately.
    const revoked = await tx.session.updateMany({
      where: { userId: grant.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // No other recovery grant for this account may outlive a successful reset.
    await invalidateOutstandingGrants(grant.userId, tx);

    const base = { userId: grant.userId, method: grant.method, ip: ctx.ip, userAgent: ctx.userAgent };
    await recordRecoveryAudit({ ...base, event: "GRANT_CONSUMED", outcome: "SUCCESS" }, tx);
    await recordRecoveryAudit(
      { ...base, event: "PASSWORD_RECOVERED", outcome: "SUCCESS", metadata: { sessionsRevoked: revoked.count } },
      tx
    );
    return { userId: grant.userId, shopId: user.shopId, method: grant.method };
  });

  // Post-commit, best effort: the reset has already succeeded and must never
  // be undone or reported as failed because a notification/audit write failed.
  await recordAudit({
    action: "PASSWORD_RESET_COMPLETED",
    actorId: outcome.userId,
    actorRole: "ADMIN",
    shopId: outcome.shopId,
    entityType: "User",
    entityId: outcome.userId,
    metadata: { via: `ADMIN_RECOVERY_${outcome.method}` },
  }).catch(() => undefined);

  let notified = false;
  try {
    const user = await prisma.user.findUnique({
      where: { id: outcome.userId },
      select: { email: true, name: true },
    });
    if (user) {
      await sendAdminPasswordRecovered(user.email, user.name, {
        method: outcome.method,
        at: new Date(),
        ip: ctx.ip ?? null,
      });
      notified = true;
    }
  } catch {
    notified = false;
  }

  return { userId: outcome.userId, notified };
}
