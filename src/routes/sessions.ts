import type { FastifyInstance } from "fastify";
import type { CashierSession } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { parseBody } from "../lib/validate.js";
import { toCashierSession } from "../lib/serializeCashier.js";
import { summarizeSession } from "../services/sessionService.js";
import { toNumber } from "../lib/money.js";

/**
 * Merges the raw session row with its live sales summary (same
 * summarizeSession() the admin app already uses) so the cashier UI never
 * has to fall back to undefined totals. expectedCash mirrors the formula
 * used by admin/sessions.ts (:id route): openingCash + cashSales.
 */
async function withSummary(session: CashierSession) {
  const summary = await summarizeSession(session.id);
  return {
    sales: summary.sales,
    cashSales: summary.cashSales,
    upiSales: summary.upiSales,
    cardSales: summary.cardSales,
    creditSales: summary.creditSales,
    expectedCash: toNumber(session.openingCash) + summary.cashSales,
  };
}

const startSessionSchema = z.object({
  shopId: z.string().min(1),
  openingCash: z.number().min(0),
});

const closeSessionSchema = z.object({
  sessionId: z.string().min(1),
  actualClosingCash: z.number().min(0),
});

export default async function sessionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("CASHIER"));

  // ── GET /api/sessions/current ────────────────────────────────────────
  fastify.get("/current", async (request) => {
    const cashier = request.authUser!;
    const session = await prisma.cashierSession.findFirst({
      where: { cashierId: cashier.id, status: "OPEN" },
      orderBy: { openedAt: "desc" },
    });
    if (!session) {
      throw Errors.notFound("No active session. Start one before billing.", "NO_ACTIVE_SESSION");
    }
    return { ...toCashierSession(session), ...(await withSummary(session)) };
  });

  // ── POST /api/sessions/start ─────────────────────────────────────────
  fastify.post("/start", async (request) => {
    const cashier = request.authUser!;
    const body = parseBody(startSessionSchema, request.body);

    if (!cashier.shopId || cashier.shopId !== body.shopId) {
      throw Errors.forbidden("You can only start a session for your assigned shop.", "SHOP_MISMATCH");
    }

    const existing = await prisma.cashierSession.findFirst({
      where: { cashierId: cashier.id, status: "OPEN" },
    });
    if (existing) {
      throw Errors.conflict(
        "A session is already active. Close it before starting a new one.",
        "SESSION_ALREADY_ACTIVE"
      );
    }

    const session = await prisma.cashierSession.create({
      data: {
        cashierId: cashier.id,
        shopId: body.shopId,
        openingCash: body.openingCash,
      },
    });
    // Brand new session — summary will just be all zeros, but returning it
    // via the same helper keeps this response shape identical to /current
    // and avoids ever handing the UI an undefined total.
    return { ...toCashierSession(session), ...(await withSummary(session)) };
  });

  // ── POST /api/sessions/close ─────────────────────────────────────────
  fastify.post("/close", async (request) => {
    const cashier = request.authUser!;
    const body = parseBody(closeSessionSchema, request.body);

    const session = await prisma.cashierSession.findUnique({ where: { id: body.sessionId } });
    if (!session || session.cashierId !== cashier.id) {
      throw Errors.notFound("Session not found.", "SESSION_NOT_FOUND");
    }
    if (session.status !== "OPEN") {
      throw Errors.conflict("This session is already closed.", "SESSION_ALREADY_CLOSED");
    }

    // Summarize BEFORE closing — same live totals the close-confirmation
    // modal already showed the cashier, so "expected" can't drift between
    // what they agreed to and what gets persisted here.
    const summary = await withSummary(session);

    const closed = await prisma.cashierSession.update({
      where: { id: session.id },
      data: {
        status: "CLOSED",
        actualClosingCash: body.actualClosingCash,
        closedAt: new Date(),
      },
    });
    return {
      ...toCashierSession(closed),
      ...summary,
      difference: Math.round((body.actualClosingCash - summary.expectedCash) * 100) / 100,
    };
  });
}
