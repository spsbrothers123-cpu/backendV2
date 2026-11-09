import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { parseBody } from "../lib/validate.js";
import {
  GENERIC_REQUEST_MESSAGE,
  resetPasswordWithCode,
  submitRecoveryRequest,
} from "../lib/cashierRecovery.js";

/**
 * Cashier Forgot Password — /api/auth/cashier-recovery   (admin-assisted)
 *
 * UNAUTHENTICATED by design (the Cashier cannot log in). REPLACES the old
 * emailed-link reset for Cashiers. No route accepts a user id, role or shop id,
 * and none returns a token/grant: the only way to change the password is the
 * one-time code the Central Admin hands over in person.
 *
 * Every safeguard (durable throttling, generic failures, atomic single-use
 * consumption) lives in lib/cashierRecovery.ts. These routes validate the
 * request envelope only.
 */

// Cheap in-memory per-IP filter in front of the durable limits; off under tests.
const rl = (
  max: number,
  timeWindow: string
): { rateLimit: false | { max: number; timeWindow: string } } =>
  env.NODE_ENV === "test" ? { rateLimit: false } : { rateLimit: { max, timeWindow } };

const emailSchema = z.string().trim().min(1, "Email is required.").max(320).email("Enter a valid email address.");

const requestSchema = z.object({ email: emailSchema });

const resetSchema = z.object({
  email: emailSchema,
  code: z.string().min(1, "Enter the recovery code.").max(64),
  newPassword: z.string().min(1, "Password is required.").max(200),
});

export default async function cashierRecoveryRoutes(fastify: FastifyInstance) {
  // Responses/requests carry recovery material — never cacheable.
  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  const ctxOf = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ip: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
  });

  // POST /request — same answer for any email, in any account state.
  fastify.post("/request", { config: rl(5, "10 minutes") }, async (request) => {
    const body = parseBody(requestSchema, request.body);
    await submitRecoveryRequest({ email: body.email, ctx: ctxOf(request) });
    return { success: true, data: null, message: GENERIC_REQUEST_MESSAGE };
  });

  // POST /reset — redeem the Admin-issued code and set the new password, atomically.
  fastify.post("/reset", { config: rl(10, "10 minutes") }, async (request) => {
    const body = parseBody(resetSchema, request.body);
    await resetPasswordWithCode({
      email: body.email,
      code: body.code,
      newPassword: body.newPassword,
      ctx: ctxOf(request),
    });
    return { success: true, data: null, message: "Your password has been reset. Please sign in with your new password." };
  });
}
