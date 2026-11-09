import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { requireRecentAuth } from "../../lib/recentAuth.js";
import { requirePepper } from "../../lib/recoveryCrypto.js";
import {
  RECOVERY_CODE_COUNT,
  countActiveRecoveryCodes,
  generateRecoveryCodeSet,
} from "../../lib/recoveryCodes.js";
import {
  MAX_PASSKEYS_PER_ADMIN,
  arePasskeysAvailable,
  completeRegistration,
  createRegistrationOptions,
  listPasskeys,
  removePasskey,
} from "../../lib/passkeys.js";

/**
 * Admin Security Settings (Phase 2) — /api/admin/security
 *
 * ADMIN-only: the role gate below runs for every route in this file, and
 * every query is scoped to request.authUser.id. A Cashier token gets 403; no
 * route accepts a userId from the client, so there is no way to read or
 * change another account's recovery credentials.
 *
 * Sensitive actions require the Admin's current password on that request
 * (lib/recentAuth.ts).
 */

// Same pattern as routes/auth.ts: per-route IP limits in production, off
// under tests (every inject() shares one bucket and would starve the suite).
const rl = (
  max: number,
  timeWindow: string
): { rateLimit: false | { max: number; timeWindow: string } } =>
  env.NODE_ENV === "test" ? { rateLimit: false } : { rateLimit: { max, timeWindow } };

const reauthSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(200),
});

const passkeyRemoveParams = z.object({ id: z.string().uuid() });

// The authenticator's JSON response. We validate the envelope here (types,
// sizes) and leave cryptographic validation to @simplewebauthn/server.
const b64 = z.string().min(1).max(16_384);
const registrationResponseSchema = z
  .object({
    id: b64,
    rawId: b64,
    type: z.literal("public-key"),
    response: z
      .object({
        clientDataJSON: b64,
        attestationObject: b64,
        transports: z.array(z.string().max(32)).max(8).optional(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.unknown()).default({}),
    authenticatorAttachment: z.string().max(32).optional(),
  })
  .passthrough();

const registerVerifySchema = z.object({
  challengeId: z.string().uuid(),
  name: z.string().trim().min(1).max(60).optional(),
  response: registrationResponseSchema,
});

export default async function adminSecurityRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  // Credential material must never be cached by a browser or proxy.
  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  // ── GET /api/admin/security/status ──────────────────────────────────
  // Everything the Security Settings screen needs, including the flag that
  // drives the non-blocking "no recovery method" warning. Never returns
  // codes, hashes, public keys or credential IDs.
  fastify.get("/status", async (request) => {
    const admin = request.authUser!;
    const [remaining, latestCode, passkeys] = await Promise.all([
      countActiveRecoveryCodes(admin.id),
      prisma.adminRecoveryCode.findFirst({
        where: { userId: admin.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      listPasskeys(admin.id),
    ]);

    return {
      recoveryCodes: {
        configured: remaining > 0,
        remaining,
        total: RECOVERY_CODE_COUNT,
        generatedAt: latestCode?.createdAt ?? null,
      },
      passkeys: {
        available: arePasskeysAvailable(),
        max: MAX_PASSKEYS_PER_ADMIN,
        items: passkeys,
      },
      // True when the Admin has NO way to recover their account.
      noRecoveryMethodConfigured: remaining === 0 && passkeys.length === 0,
    };
  });

  // ── POST /api/admin/security/recovery-codes ─────────────────────────
  // Generates the first set of 8 codes, or regenerates (which atomically
  // revokes every previous code). The raw codes are in THIS response only —
  // the server keeps just keyed hashes and cannot show them again.
  fastify.post("/recovery-codes", { config: rl(5, "10 minutes") }, async (request) => {
    const admin = request.authUser!;
    const body = parseBody(reauthSchema, request.body);
    const ctx = { ip: request.ip, userAgent: request.headers["user-agent"] };

    // Fail closed (503) before spending a password attempt if the server
    // isn't configured to hash recovery codes.
    try {
      requirePepper(env.RECOVERY_CODE_PEPPER);
    } catch {
      throw new AppError(503, "RECOVERY_NOT_CONFIGURED", "Recovery codes are not available on this server yet.");
    }

    await requireRecentAuth(admin.id, body.currentPassword, ctx);

    const result = await generateRecoveryCodeSet(admin.id, ctx);
    return {
      codes: result.codes,
      total: RECOVERY_CODE_COUNT,
      regenerated: result.regenerated,
      generatedAt: new Date().toISOString(),
    };
  });

  // ── POST /api/admin/security/passkeys/register/options ──────────────
  fastify.post("/passkeys/register/options", { config: rl(10, "10 minutes") }, async (request) => {
    const admin = request.authUser!;
    const body = parseBody(reauthSchema, request.body);
    const ctx = { ip: request.ip, userAgent: request.headers["user-agent"] };

    // Don't make the Admin type their password just to be told passkeys
    // aren't configured on the server.
    if (!arePasskeysAvailable()) {
      throw new AppError(
        503,
        "PASSKEYS_NOT_CONFIGURED",
        "Passkeys are not available on this server yet. Recovery codes can still be used."
      );
    }

    await requireRecentAuth(admin.id, body.currentPassword, ctx);
    return createRegistrationOptions({ id: admin.id, email: admin.email, name: admin.name });
  });

  // ── POST /api/admin/security/passkeys/register/verify ───────────────
  fastify.post("/passkeys/register/verify", { config: rl(10, "10 minutes") }, async (request) => {
    const admin = request.authUser!;
    const body = parseBody(registerVerifySchema, request.body);
    const passkey = await completeRegistration({
      userId: admin.id,
      challengeId: body.challengeId,
      response: body.response as never,
      name: body.name,
      ctx: { ip: request.ip, userAgent: request.headers["user-agent"] },
    });
    return { passkey };
  });

  // ── POST /api/admin/security/passkeys/:id/remove ────────────────────
  // POST (not DELETE) because it carries the re-authentication password in
  // the body, and DELETE bodies are dropped by some proxies/clients.
  fastify.post("/passkeys/:id/remove", { config: rl(10, "10 minutes") }, async (request) => {
    const admin = request.authUser!;
    const params = parseBody(passkeyRemoveParams, request.params);
    const body = parseBody(reauthSchema, request.body);
    const ctx = { ip: request.ip, userAgent: request.headers["user-agent"] };

    await requireRecentAuth(admin.id, body.currentPassword, ctx);
    await removePasskey(admin.id, params.id, ctx);
    return { success: true };
  });

}
