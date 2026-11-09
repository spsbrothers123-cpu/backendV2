import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { Errors } from "../../lib/errors.js";
import {
  resolveConsolidationPeriod,
  resolveConsolidationScope,
  type ConsolidationPeriod,
  ymdInBusinessTime,
} from "../../lib/consolidationScope.js";
import {
  buildConsolidationExportPayload,
  CONSOLIDATION_SECTIONS,
  getCustomers,
  getExpenses,
  getLowStock,
  getOverview,
  getProductStock,
  getPurchases,
  getSales,
  LIVE_SECTIONS,
} from "../../services/consolidationService.js";
import {
  buildReportExcelBuffer,
  buildReportPdfBuffer,
  contentTypeFor,
  type ExportFileFormat,
} from "../../services/exportService.js";

/**
 * Consolidation — read-only, cross-shop reporting for one Admin.
 *
 * ISOLATION: this plugin never reads request.authUser.shopId (the global
 * shop selector) and never writes User.shopId. The authorized shop set is
 * derived from the authenticated admin's id (AdminShopLink) on every request,
 * and the optional `shop`/`shopId` query filter is validated against it:
 *   omitted | "all" → every authorized shop
 *   <id>            → that shop only, 403 SHOP_ACCESS_DENIED if not owned
 * Client-supplied admin ids are not accepted anywhere.
 */

const scopeFields = {
  shop: z.string().trim().optional(),
  shopId: z.string().trim().optional(), // alias of `shop`
};
const dateFields = {
  range: z.enum(["today", "yesterday", "last7", "last30", "custom"]).optional(),
  dateFrom: z.string().trim().optional(),
  dateTo: z.string().trim().optional(),
};
const pageFields = {
  search: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
};

const dateQuery = z.object({ ...scopeFields, ...dateFields });
const liveListQuery = z.object({ ...scopeFields, ...pageFields }); // stock: no date params
const customersQuery = z.object({ ...scopeFields, ...dateFields, ...pageFields });
const exportQuery = z.object({
  ...scopeFields,
  ...dateFields,
  scope: z.enum(["section", "full"]).default("full"),
  section: z.enum(CONSOLIDATION_SECTIONS as [string, ...string[]]).optional(),
  format: z.enum(["excel", "pdf"]).default("excel"),
});

const shopParam = (q: { shop?: string; shopId?: string }) => q.shop || q.shopId || undefined;
const ok = <T>(data: T) => ({ success: true, data, message: "Success" });

export default async function adminConsolidationRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));
  // Admin-specific financial data: never cache.
  fastify.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  fastify.get<{ Querystring: Record<string, string> }>("/overview", async (request) => {
    const q = dateQuery.parse(request.query);
    const { shops } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));
    return ok(await getOverview(shops, resolveConsolidationPeriod(q)));
  });

  // Shop-wise sales comparison (spec §3B). /sales returns the same payload.
  const salesHandler = async (request: FastifyRequest) => {
    const q = dateQuery.parse(request.query);
    const { shops } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));
    return ok(await getSales(shops, resolveConsolidationPeriod(q)));
  };
  fastify.get("/shops", salesHandler);
  fastify.get("/sales", salesHandler);

  // LIVE stock — date params are intentionally not part of this schema.
  fastify.get<{ Querystring: Record<string, string> }>("/products", async (request) => {
    const q = liveListQuery.parse(request.query);
    const { shops } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));
    return ok(await getProductStock(shops, { search: q.search, page: q.page, pageSize: q.pageSize }));
  });

  fastify.get<{ Querystring: Record<string, string> }>("/low-stock", async (request) => {
    const q = liveListQuery.parse(request.query);
    const { shops } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));
    return ok(await getLowStock(shops, { search: q.search, page: q.page, pageSize: q.pageSize }));
  });

  fastify.get<{ Querystring: Record<string, string> }>("/customers", async (request) => {
    const q = customersQuery.parse(request.query);
    const { shops } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));
    return ok(await getCustomers(shops, resolveConsolidationPeriod(q), { search: q.search, page: q.page, pageSize: q.pageSize }));
  });

  fastify.get<{ Querystring: Record<string, string> }>("/purchases", async (request) => {
    const q = dateQuery.parse(request.query);
    const { shops } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));
    return ok(await getPurchases(shops, resolveConsolidationPeriod(q)));
  });

  fastify.get<{ Querystring: Record<string, string> }>("/expenses", async (request) => {
    const q = dateQuery.parse(request.query);
    const { shops } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));
    return ok(await getExpenses(shops, resolveConsolidationPeriod(q)));
  });

  // ── GET /export?scope=section|full&section=&format=excel|pdf ─────────
  fastify.get<{ Querystring: Record<string, string> }>("/export", async (request, reply) => {
    const q = exportQuery.parse(request.query);
    if (q.scope === "section" && !q.section) {
      throw Errors.badRequest("section is required when scope=section.", "SECTION_REQUIRED");
    }
    const { shops, selectedShopId } = await resolveConsolidationScope(request.authUser!.id, shopParam(q));

    // Live-only sections (products, low-stock) don't need a valid date range.
    const liveOnly = q.scope === "section" && LIVE_SECTIONS.includes(q.section as never);
    let period: ConsolidationPeriod | null;
    if (liveOnly) {
      try {
        period = resolveConsolidationPeriod(q);
      } catch {
        period = null;
      }
    } else {
      period = resolveConsolidationPeriod(q);
    }

    const { title, payload } = await buildConsolidationExportPayload({
      scope: q.scope,
      section: q.section as never,
      shops,
      selectedShopId,
      period,
    });

    const format = q.format as ExportFileFormat;
    const buffer =
      format === "pdf"
        ? await buildReportPdfBuffer(title, `Generated ${new Date().toISOString()}`, payload)
        : await buildReportExcelBuffer(payload);

    const day = ymdInBusinessTime(new Date());
    const base = q.scope === "full" ? "consolidation-report" : `consolidation-${q.section}`;
    const filename = `${base}-${day}.${format === "pdf" ? "pdf" : "xlsx"}`;
    return reply
      .header("Content-Type", contentTypeFor(format))
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(buffer);
  });
}
