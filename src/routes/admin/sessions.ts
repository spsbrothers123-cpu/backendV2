import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { toActiveSession, toSessionHistoryItem, paginate } from "../../lib/serializeAdmin.js";
import { summarizeSession } from "../../services/sessionService.js";
import { toNumber } from "../../lib/money.js";
import { listShopsForAdmin } from "../../lib/shopAccess.js";

const historyQuerySchema = z.object({
  // A cashier ID (Phase 3), not a name — two cashiers at different shops
  // can share a display name, and this page now spans every shop the
  // admin owns (see comment on GET /active below), so a name match could
  // silently merge two different people's sessions.
  cashier: z.string().optional(),
  status: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

export default async function adminSessionsRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/sessions/active ────────────────────────────────────
  // Phase 3 spec §2: Sessions is a deliberate EXCEPTION to the Global Shop
  // Selector. The Admin inspects sessions by picking a cashier (existing
  // dropdown, now sourced from every shop — see GET /api/admin/cashiers),
  // not by which shop happens to be currently active. So this always spans
  // every shop the admin owns rather than filtering to admin.shopId.
  fastify.get("/active", async (request) => {
    const admin = request.authUser!;
    const shopIds = (await listShopsForAdmin(admin.id)).map((s) => s.id);
    const sessions = shopIds.length
      ? await prisma.cashierSession.findMany({
          where: { shopId: { in: shopIds }, status: "OPEN" },
          include: { cashier: true, shop: true },
          orderBy: { openedAt: "desc" },
        })
      : [];
    const withSummaries = await Promise.all(
      sessions.map(async (s) => toActiveSession(s, await summarizeSession(s.id)))
    );
    return withSummaries;
  });

  // ── GET /api/admin/sessions/history ───────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/history", async (request) => {
    const admin = request.authUser!;
    const q = historyQuerySchema.parse(request.query);
    const shopIds = (await listShopsForAdmin(admin.id)).map((s) => s.id);

    if (shopIds.length === 0) {
      return paginate([], 0, q.page, q.pageSize);
    }

    const where = {
      // Scoped to every shop this admin owns (never just the currently
      // active one) — the compound filter below with cashierId also means
      // a cashierId from a shop this admin doesn't own simply matches
      // nothing, rather than needing a separate ownership check.
      shopId: { in: shopIds },
      ...(q.status && q.status !== "all" ? { status: q.status === "Open" ? ("OPEN" as const) : ("CLOSED" as const) } : {}),
      ...(q.cashier && q.cashier !== "all" ? { cashierId: q.cashier } : {}),
    };

    const all = await prisma.cashierSession.findMany({
      where,
      include: { cashier: true, shop: true },
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
    const shopIds = (await listShopsForAdmin(admin.id)).map((s) => s.id);
    const session = await prisma.cashierSession.findUnique({
      where: { id: request.params.id },
      include: { cashier: true, shop: true },
    });
    if (!session || !shopIds.includes(session.shopId)) {
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
