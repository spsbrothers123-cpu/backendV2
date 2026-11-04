import { randomBytes, randomUUID } from "node:crypto";
import {
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
} from "@simplewebauthn/server";
import { prisma } from "./prisma.js";
import { AppError, Errors } from "./errors.js";
import { recordRecoveryAudit } from "./recoveryAudit.js";
import {
  arePasskeysAvailable,
  getWebAuthnConfig,
  verifyPasskeyRegistration,
  type VerifiedPasskey,
  type WebAuthnConfig,
} from "./webauthn.js";

export { arePasskeysAvailable };

/**
 * Admin passkeys (WebAuthn) — registration, listing, removal.
 *
 * Only PUBLIC keys are stored. Private keys and biometric data never leave
 * the user's authenticator (Windows Hello, Touch ID, a phone, a security
 * key, …) and are never visible to this server.
 *
 * Phase 2 covers registration/management. Using a passkey to authorize a
 * password recovery (the authentication ceremony) is Phase 3.
 */

export const MAX_PASSKEYS_PER_ADMIN = 10;
export const REGISTRATION_CHALLENGE_TTL_MS = 5 * 60_000;

function requireConfig(): WebAuthnConfig {
  const config = getWebAuthnConfig();
  if (!config) {
    throw new AppError(
      503,
      "PASSKEYS_NOT_CONFIGURED",
      "Passkeys are not available on this server yet. Recovery codes can still be used."
    );
  }
  return config;
}

// ── Service functions ───────────────────────────────────────────────────

export interface RequestContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: string;
  backedUp: boolean;
}

const summarySelect = {
  id: true,
  name: true,
  createdAt: true,
  lastUsedAt: true,
  deviceType: true,
  backedUp: true,
} as const;

/** Never selects publicKey/credentialId/userHandle — not needed by any client. */
export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  return prisma.adminPasskey.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: summarySelect,
  });
}

/**
 * Step 1 of registration: issues WebAuthn creation options and stores the
 * challenge server-side (single-use, 5 minutes). The caller must already
 * have passed requireRecentAuth().
 */
export async function createRegistrationOptions(user: {
  id: string;
  email: string;
  name: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const config = requireConfig();

  const existing = await prisma.adminPasskey.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true, userHandle: true },
  });
  if (existing.length >= MAX_PASSKEYS_PER_ADMIN) {
    throw Errors.conflict(
      `You can register at most ${MAX_PASSKEYS_PER_ADMIN} passkeys. Remove one first.`,
      "PASSKEY_LIMIT_REACHED"
    );
  }

  // One stable, non-PII handle per account: reuse it if the Admin already
  // has passkeys, otherwise mint a fresh random one (never derived from the
  // email or user id).
  const userHandle = existing[0]?.userHandle ?? randomBytes(32).toString("base64url");

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: Buffer.from(userHandle, "base64url"),
    attestationType: "none", // we need a key, not a hardware attestation
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    // Phase 3: Forgot Password uses a discoverable-credential ceremony (empty
    // allowCredentials) so the options never depend on the email typed — that
    // is what keeps account enumeration impossible. It therefore needs the
    // passkey to be resident on the authenticator.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: 60_000,
  });

  const challengeId = randomUUID();
  const now = new Date();
  await prisma.$transaction([
    // Only one live registration ceremony per Admin: starting a new one
    // retires any earlier unfinished challenge.
    prisma.adminPasskeyChallenge.updateMany({
      where: { userId: user.id, purpose: "REGISTRATION", consumedAt: null },
      data: { consumedAt: now },
    }),
    prisma.adminPasskeyChallenge.create({
      data: {
        id: challengeId,
        userId: user.id,
        purpose: "REGISTRATION",
        challenge: options.challenge,
        userHandle,
        expiresAt: new Date(now.getTime() + REGISTRATION_CHALLENGE_TTL_MS),
      },
    }),
    // Housekeeping: drop challenges that expired more than an hour ago.
    prisma.adminPasskeyChallenge.deleteMany({
      where: { expiresAt: { lt: new Date(now.getTime() - 60 * 60_000) } },
    }),
  ]);

  return { challengeId, options };
}

async function auditRegistrationFailure(userId: string, reason: string, ctx: RequestContext) {
  await recordRecoveryAudit({
    userId,
    event: "PASSKEY_REGISTRATION_FAILED",
    outcome: "FAILURE",
    method: "PASSKEY",
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { reason },
  });
}

/**
 * Step 2 of registration: verifies the authenticator's response and stores
 * the public key. The challenge is consumed atomically BEFORE verification,
 * so a challenge can never be used twice — a failed attempt burns it and the
 * Admin simply starts over.
 */
export async function completeRegistration(input: {
  userId: string;
  challengeId: string;
  response: RegistrationResponseJSON;
  name?: string;
  ctx?: RequestContext;
}): Promise<PasskeySummary> {
  const ctx = input.ctx ?? {};
  const config = requireConfig();
  const now = new Date();

  // Atomic single-use claim, bound to this account and purpose.
  const claimed = await prisma.adminPasskeyChallenge.updateMany({
    where: {
      id: input.challengeId,
      userId: input.userId,
      purpose: "REGISTRATION",
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });
  if (claimed.count !== 1) {
    await auditRegistrationFailure(input.userId, "challenge_invalid", ctx);
    throw Errors.badRequest(
      "This passkey setup session has expired. Please start again.",
      "PASSKEY_CHALLENGE_INVALID"
    );
  }

  const challenge = await prisma.adminPasskeyChallenge.findUniqueOrThrow({
    where: { id: input.challengeId },
    select: { challenge: true, userHandle: true },
  });

  let verified: VerifiedPasskey;
  try {
    verified = await verifyPasskeyRegistration({
      response: input.response,
      expectedChallenge: challenge.challenge,
      config,
    });
  } catch {
    await auditRegistrationFailure(input.userId, "verification_failed", ctx);
    throw Errors.badRequest(
      "We couldn't verify that passkey. Please try again.",
      "PASSKEY_VERIFICATION_FAILED"
    );
  }

  const name = input.name?.trim() || `Passkey added ${now.toISOString().slice(0, 10)}`;

  try {
    return await prisma.$transaction(async (tx) => {
      // Serialise with other registrations for this Admin so the per-account
      // limit cannot be exceeded by concurrent requests.
      const locked = await tx.$queryRaw<Array<{ role: string; status: string }>>`
        SELECT "role"::text AS role, "status"::text AS status
        FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
      const user = locked[0];
      if (!user || user.role !== "ADMIN" || user.status !== "ACTIVE") {
        throw Errors.forbidden("Passkeys are only available to active Admin accounts.", "ROLE_NOT_ALLOWED");
      }
      const count = await tx.adminPasskey.count({ where: { userId: input.userId } });
      if (count >= MAX_PASSKEYS_PER_ADMIN) {
        throw Errors.conflict(
          `You can register at most ${MAX_PASSKEYS_PER_ADMIN} passkeys. Remove one first.`,
          "PASSKEY_LIMIT_REACHED"
        );
      }

      const row = await tx.adminPasskey.create({
        data: {
          userId: input.userId,
          credentialId: verified.credentialId,
          publicKey: Buffer.from(verified.publicKey),
          counter: verified.counter,
          transports: verified.transports,
          deviceType: verified.deviceType,
          backedUp: verified.backedUp,
          userHandle: challenge.userHandle,
          name,
        },
        select: summarySelect,
      });

      await recordRecoveryAudit(
        {
          userId: input.userId,
          event: "PASSKEY_REGISTERED",
          outcome: "SUCCESS",
          method: "PASSKEY",
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          metadata: { entityId: row.id, deviceType: verified.deviceType, backedUp: verified.backedUp },
        },
        tx
      );
      return row;
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    // Unique violation on credentialId: this authenticator credential is
    // already registered (to this or another account). Same answer either way.
    if ((err as { code?: string })?.code === "P2002") {
      await auditRegistrationFailure(input.userId, "credential_exists", ctx);
      throw Errors.conflict("This passkey is already registered.", "PASSKEY_ALREADY_REGISTERED");
    }
    throw err;
  }
}

/**
 * Removes one of the caller's own passkeys. The delete is scoped by userId,
 * so passkey IDs belonging to other accounts are indistinguishable from
 * nonexistent ones (404). The caller must already have passed
 * requireRecentAuth().
 */
export async function removePasskey(userId: string, passkeyId: string, ctx: RequestContext = {}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const result = await tx.adminPasskey.deleteMany({ where: { id: passkeyId, userId } });
    if (result.count !== 1) throw Errors.notFound("Passkey not found.", "PASSKEY_NOT_FOUND");
    await recordRecoveryAudit(
      {
        userId,
        event: "PASSKEY_REMOVED",
        outcome: "SUCCESS",
        method: "PASSKEY",
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        metadata: { entityId: passkeyId },
      },
      tx
    );
  });
}
