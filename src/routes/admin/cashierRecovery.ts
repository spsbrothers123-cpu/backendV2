import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { assertCentralAdmin } from "../../lib/centralAdmin.js";
import { requireRecentAuth } from "../../lib/recentAuth.js";
import {
  approveRecoveryRequest,
  listRecoveryRequests,
  rejectRecoveryRequest,
} from "../../lib/cashierRecovery.js";

/**
 * Central Admin — Cashier recovery management: /api/admin/cashier-recovery
 *
 * Only the ONE configured Central Admin (CENTRAL_ADMIN_USER_ID) may use these
 * routes. Authorization is enforced HERE, on the backend, and is deliberately
 * independent of AdminShopLink and of the currently selected shop: requests
 * from every shop are visible. Other ADMIN accounts get 403; Cashiers and
 * anonymous callers are refused by requireRole before this runs.
 */

const rl = (
  max: number,
  timeWindow: string
): { rateLimit: false | { max: number; timeWindow: string } } =>
  env.NODE_ENV === "test" ? { rateLimit: false } : { rateLimit: { max, timeWindow } };

const listQuerySchema = z.object({
  filter: z.enum(["active", "history", "all"]).default("active"),
});

const approveSchema = z.object({
  /** Recent re-authentication: verified server-side on THIS request. */
  currentPassword: z.string().min(1, "Your password is required.").max(200),
  /** Explicit confirmation that the cashier's identity was verified in person. */
  identityVerified: z.literal(true, {
    errorMap: () => ({ message: "Confirm that you verified the cashier's identity in person." }),
  }),
});

const idParamSchema = z.object({ id: z.string().uuid("Invalid request id.") });

export default async function adminCashierRecoveryRoutes(fastify: FastifyInstance) {
  // The approve response carries the one-time code — never cacheable.
  fastify.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  fastify.addHook("preHandler", async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      assertCentralAdmin(request.authUser);
    } catch (err) {
      // A non-central ADMIN probing these routes is worth a trail.
      if (err instanceof AppError && err.code === "CENTRAL_ADMIN_REQUIRED" && request.authUser) {
        await recordAudit({
          action: "CASHIER_RECOVERY_DENIED",
          actorId: request.authUser.id,
          actorRole: "ADMIN",
          entityType: "CashierRecoveryRequest",
          metadata: { route: request.routeOptions?.url ?? "unknown" },
        });
      }
      throw err;
    }
  });

  const ctxOf = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
  });

  // GET /?filter=active|history|all — every shop, no shop scoping.
  fastify.get("/", async (request) => {
    const q = parseBody(listQuerySchema, request.query ?? {});
    const data = await listRecoveryRequests(q.filter);
    return { success: true, data, message: "Success" };
  });

  // POST /:id/approve — in-person confirmation + password re-auth → one-time code (shown once).
  fastify.post<{ Params: { id: string } }>("/:id/approve", { config: rl(10, "10 minutes") }, async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const body = parseBody(approveSchema, request.body);
    const admin = request.authUser!;

    await requireRecentAuth(admin.id, body.currentPassword, ctxOf(request));
    const result = await approveRecoveryRequest({ requestId: id, adminId: admin.id, ctx: ctxOf(request) });

    return {
      success: true,
      data: { code: result.code, expiresAt: result.expiresAt, request: result.request },
      message: "Recovery code issued. Hand it to the cashier in person — it will not be shown again.",
    };
  });

  // POST /:id/reject — reject a pending request, or revoke an approved one.
  fastify.post<{ Params: { id: string } }>("/:id/reject", { config: rl(20, "10 minutes") }, async (request) => {
    const { id } = parseBody(idParamSchema, request.params);
    const data = await rejectRecoveryRequest({ requestId: id, adminId: request.authUser!.id });
    return { success: true, data, message: "Recovery request rejected." };
  });
}
