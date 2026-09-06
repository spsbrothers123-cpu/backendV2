import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { toActiveSession, toSessionHistoryItem, paginate } from "../../lib/serializeAdmin.js";
import { summarizeSession } from "../../services/sessionService.js";
import { toNumber } from "../../lib/money.js";

const historyQuerySchema = z.object({
  cashier: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

export default async function adminSessionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/sessions/active ────────────────────────────────────
  fastify.get("/active", async (request) => {
    const admin = request.authUser!;
    const sessions = await prisma.cashierSession.findMany({
      where: { shopId: admin.shopId!, status: "OPEN" },
      include: { cashier: true, shop: true },
      orderBy: { openedAt: "desc" },
    });
    const withSummaries = await Promise.all(
      sessions.map(async (s) => toActiveSession(s, await summarizeSession(s.id)))
    );
    return withSummaries;
  });

  // ── GET /api/admin/sessions/history ───────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/history", async (request) => {
    const admin = request.authUser!;
    const q = historyQuerySchema.parse(request.query);

    const where = {
      shopId: admin.shopId!,
      ...(q.status && q.status !== "all" ? { status: q.status === "Open" ? ("OPEN" as const) : ("CLOSED" as const) } : {}),
      ...(q.cashier && q.cashier !== "all" ? { cashier: { name: q.cashier } } : {}),
    };

    const all = await prisma.cashierSession.findMany({
      where,
      include: { cashier: true },
      orderBy: { openedAt: "desc" },
    });

    const items = await Promise.all(
      all.map(async (s) => toSessionHistoryItem(s, await summarizeSession(s.id)))
    );

    const start = (q.page - 1) * q.pageSize;
    return paginate(items.slice(start, start + q.pageSize), items.length, q.page, q.pageSize);
  });

  // ── GET /api/admin/sessions/:id ────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    const session = await prisma.cashierSession.findUnique({
      where: { id: request.params.id },
      include: { cashier: true },
    });
    if (!session || session.shopId !== admin.shopId) {
      throw Errors.notFound("Session not found.", "SESSION_NOT_FOUND");
    }

    const summary = await summarizeSession(session.id);
    const base = toSessionHistoryItem(session, summary);
    const expectedClosingCash = toNumber(session.openingCash) + summary.cashSales;

    const bills = await prisma.bill.findMany({
      where: { sessionId: session.id, status: "PAID" },
      orderBy: { createdAt: "asc" },
    });
    const activity = [
      { id: `${session.id}-open`, time: session.openedAt.toISOString(), description: "Session opened" },
      ...bills.map((b) => ({
        id: b.id,
        time: b.createdAt.toISOString(),
        description: `Sale ${b.billNumber} — ₹${toNumber(b.grandTotal).toFixed(2)}`,
      })),
      ...(session.closedAt
        ? [{ id: `${session.id}-close`, time: session.closedAt.toISOString(), description: "Session closed" }]
        : []),
    ];

    return {
      ...base,
      cashSales: summary.cashSales,
      upiSales: summary.upiSales,
      cardSales: summary.cardSales,
      creditSales: summary.creditSales,
      expectedClosingCash,
      activity,
    };
  });
}
