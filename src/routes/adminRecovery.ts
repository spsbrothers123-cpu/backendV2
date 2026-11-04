import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { parseBody } from "../lib/validate.js";
import {
  createPasskeyAuthenticationOptions,
  resetPasswordWithGrant,
  verifyPasskeyRecovery,
  verifyRecoveryCode,
} from "../lib/adminRecovery.js";

/**
 * Admin Forgot Password — /api/auth/admin/recovery   (Phase 3)
 *
 * UNAUTHENTICATED by design (the Admin has lost their password), so every
 * safeguard lives in lib/adminRecovery.ts: per-account + per-IP durable
 * throttling, one generic failure for every cause, atomic single-use
 * credentials and grants, and a grant that is bound to one account and one
 * client. These routes only validate the request envelope.
 *
 * No route accepts a userId, role or shopId. The password-reset route does
 * not even accept an email: the account is whatever the grant was issued to.
 *
 * This REPLACES the email reset link for Admin accounts. Cashier password
 * recovery (/api/auth/forgot-password) is untouched.
 */

// Per-route IP limits in production (a cheap first filter in front of the
// durable throttle); off under tests, same as routes/auth.ts.
const rl = (
  max: number,
  timeWindow: string
): { rateLimit: false | { max: number; timeWindow: string } } =>
  env.NODE_ENV === "test" ? { rateLimit: false } : { rateLimit: { max, timeWindow } };

const emailSchema = z.string().trim().min(1, "Email is required.").max(320).email("Enter a valid email address.");

const codeVerifySchema = z.object({
  email: emailSchema,
  code: z.string().min(1, "Enter a recovery code.").max(64),
});

const passkeyOptionsSchema = z.object({ email: emailSchema });

// Validate the envelope (types/sizes); the cryptography is @simplewebauthn's.
const b64 = z.string().min(1).max(16_384);
const assertionSchema = z
  .object({
    id: b64,
    rawId: b64,
    type: z.literal("public-key"),
    response: z
      .object({
        clientDataJSON: b64,
        authenticatorData: b64,
        signature: b64,
        userHandle: b64.optional(),
      })
      .passthrough(),
    clientExtensionResults: z.record(z.unknown()).default({}),
    authenticatorAttachment: z.string().max(32).optional(),
  })
  .passthrough();

const passkeyVerifySchema = z.object({
  email: emailSchema,
  challengeId: z.string().uuid(),
  response: assertionSchema,
});

const resetSchema = z.object({
  grantToken: z.string().min(1, "Recovery session is missing.").max(100),
  newPassword: z.string().min(1, "Password is required.").max(200),
});

export default async function adminRecoveryRoutes(fastify: FastifyInstance) {
  // Responses carry credential material (grant tokens) — never cacheable.
  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  const ctxOf = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ip: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
  });

  // POST /passkey/options — start the passkey ceremony. Same answer for any email.
  fastify.post("/passkey/options", { config: rl(10, "10 minutes") }, async (request) => {
    const body = parseBody(passkeyOptionsSchema, request.body);
    return createPasskeyAuthenticationOptions({ email: body.email, ctx: ctxOf(request) });
  });

  // POST /passkey/verify — finish it; success returns a recovery grant.
  fastify.post("/passkey/verify", { config: rl(10, "10 minutes") }, async (request) => {
    const body = parseBody(passkeyVerifySchema, request.body);
    return verifyPasskeyRecovery({
      email: body.email,
      challengeId: body.challengeId,
      response: body.response as never,
      ctx: ctxOf(request),
    });
  });

  // POST /code/verify — redeem an emergency recovery code; success returns a recovery grant.
  fastify.post("/code/verify", { config: rl(10, "10 minutes") }, async (request) => {
    const body = parseBody(codeVerifySchema, request.body);
    return verifyRecoveryCode({ email: body.email, code: body.code, ctx: ctxOf(request) });
  });

  // POST /reset-password — set the new password with a grant.
  fastify.post("/reset-password", { config: rl(10, "10 minutes") }, async (request) => {
    const body = parseBody(resetSchema, request.body);
    await resetPasswordWithGrant({
      grantToken: body.grantToken,
      newPassword: body.newPassword,
      ctx: ctxOf(request),
    });
    return { success: true, data: null, message: "Your password has been reset. Please sign in with your new password." };
  });
}
