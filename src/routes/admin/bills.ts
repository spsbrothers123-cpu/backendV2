import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseBody } from "../../lib/validate.js";
import { centralAdminOnly } from "../../lib/centralAdmin.js";
import { cancelBill } from "../../services/billCancellationService.js";

const cancelSchema = z.object({
  // Mandatory: the audit trail must say why a completed sale was voided.
  reason: z.string().trim().min(3, "A reason is required to cancel a bill.").max(500),
});

export default async function adminBillsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── POST /api/admin/bills/:id/cancel ─────────────────────────────────
  // Central Admin only (it moves stock and customer credit). The Central
  // Admin manages EVERY branch, so no per-shop link is required (same rule
  // as purchases). The bill's own branch is used for every effect — NOT the
  // admin's currently selected shop — so cancelling from the wrong branch
  // view can't mis-route stock.
  fastify.post<{ Params: { id: string } }>(
    "/:id/cancel",
    { preHandler: centralAdminOnly("cancel bills"), config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const admin = request.authUser!;
      const body = parseBody(cancelSchema, request.body);

      const r = await cancelBill({ billId: request.params.id, actorId: admin.id, reason: body.reason });
      return {
        id: r.id,
        billNumber: r.billNumber ?? r.id,
        status: "cancelled",
        cancelledAt: r.cancelledAt.toISOString(),
        cancelReason: r.cancelReason,
        cancelledAfterSessionClose: r.cancelledAfterSessionClose,
        total: r.grandTotal,
        stockRestored: r.restoredItems,
        creditReversed: r.creditReversed,
      };
    }
  );
}
