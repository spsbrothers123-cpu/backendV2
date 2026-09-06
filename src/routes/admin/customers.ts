import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminCustomer, paginate, PAYMENT_LABEL } from "../../lib/serializeAdmin.js";
import { toNumber } from "../../lib/money.js";
import { createCustomerForShop } from "../../services/customerService.js";
import {
  buildCsvBuffer,
  buildExcelBuffer,
  buildExportFilename,
  contentTypeFor,
  extensionFor,
  type ExportColumn,
} from "../../services/exportService.js";

const querySchema = z.object({
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const exportQuerySchema = querySchema.omit({ page: true, pageSize: true }).extend({
  format: z.enum(["excel", "csv"]).default("excel"),
});

/** Shared by the list endpoint and the export endpoint so filters always match what's on screen. */
function buildCustomerWhere(shopId: string, q: { search?: string }) {
  return {
    shopId,
    ...(q.search
      ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { phone: { contains: q.search } }] }
      : {}),
  };
}

const customerSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().min(1),
});

async function withPurchaseStats(shopId: string, customerId: string) {
  const agg = await prisma.bill.aggregate({
    where: { shopId, customerId, status: "PAID" },
    _sum: { grandTotal: true },
    _count: true,
  });
  return { totalPurchases: toNumber(agg._sum.grandTotal), billCount: agg._count };
}

export default async function adminCustomersRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/customers ────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = querySchema.parse(request.query);
    const where = buildCustomerWhere(admin.shopId!, q);

    const [customers, total] = await Promise.all([
      prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.customer.count({ where }),
    ]);

    const items = await Promise.all(
      customers.map(async (c) => {
        const stats = await withPurchaseStats(admin.shopId!, c.id);
        return toAdminCustomer({ ...c, ...stats });
      })
    );

    return paginate(items, total, q.page, q.pageSize);
  });

  // ── GET /api/admin/customers/export ───────────────────────────────────
  // Exports every customer matching the current search filter (no
  // pagination) as an Excel or CSV file.
  fastify.get<{ Querystring: Record<string, string> }>("/export", async (request, reply) => {
    const admin = request.authUser!;
    const q = exportQuerySchema.parse(request.query);
    const where = buildCustomerWhere(admin.shopId!, q);

    const [customers, shop] = await Promise.all([
      prisma.customer.findMany({ where, orderBy: { createdAt: "desc" } }),
      prisma.shop.findUnique({ where: { id: admin.shopId! } }),
    ]);

    const columns: ExportColumn[] = [
      { key: "id", header: "Customer ID", width: 26 },
      { key: "name", header: "Name", width: 22 },
      { key: "phone", header: "Phone", width: 16 },
      { key: "totalPurchases", header: "Total Purchases", width: 16 },
      { key: "billCount", header: "Bills", width: 10 },
      { key: "outstandingCredit", header: "Outstanding Credit", width: 18 },
      { key: "createdAt", header: "Created At", width: 22 },
    ];
    const rows = await Promise.all(
      customers.map(async (c) => {
        const stats = await withPurchaseStats(admin.shopId!, c.id);
        return {
          id: c.id,
          name: c.name,
          phone: c.phone,
          totalPurchases: stats.totalPurchases,
          billCount: stats.billCount,
          outstandingCredit: toNumber(c.creditBalance),
          createdAt: c.createdAt.toISOString(),
        };
      })
    );

    const filename = buildExportFilename(shop?.name ?? "Shop", "Customers", extensionFor(q.format));
    const buffer =
      q.format === "csv" ? buildCsvBuffer(columns, rows) : await buildExcelBuffer("Customers", columns, rows);

    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .type(contentTypeFor(q.format))
      .send(buffer);
  });

  // ── POST /api/admin/customers ────────────────────────────────────────
  fastify.post("/", async (request, reply) => {
    const admin = request.authUser!;
    const body = parseBody(customerSchema, request.body);

    const customer = await createCustomerForShop({
      shopId: admin.shopId!,
      name: body.name,
      phone: body.phone,
      actorId: admin.id,
      actorRole: "ADMIN",
    });

    return reply.code(201).send(toAdminCustomer({ ...customer, totalPurchases: 0, billCount: 0 }));
  });

  // ── PUT /api/admin/customers/:id ──────────────────────────────────────
  fastify.put<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(customerSchema, request.body);

    const existing = await prisma.customer.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
    }

    const updated = await prisma.customer.update({
      where: { id: existing.id },
      data: { name: body.name, phone: body.phone },
    });

    await recordAudit({
      action: "CUSTOMER_UPDATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Customer",
      entityId: updated.id,
    });

    const stats = await withPurchaseStats(admin.shopId!, updated.id);
    return toAdminCustomer({ ...updated, ...stats });
  });

  // ── GET /api/admin/customers/:id/purchase-history ─────────────────────
  fastify.get<{ Params: { id: string } }>("/:id/purchase-history", async (request) => {
    const admin = request.authUser!;
    const customer = await prisma.customer.findUnique({ where: { id: request.params.id } });
    if (!customer || customer.shopId !== admin.shopId) {
      throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
    }
    const bills = await prisma.bill.findMany({
      where: { shopId: admin.shopId!, customerId: customer.id, status: "PAID" },
      include: { payments: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return bills.map((b) => {
      const methods = [...new Set(b.payments.map((p) => PAYMENT_LABEL[p.method]))];
      return {
        id: b.id,
        billNumber: b.billNumber ?? b.id,
        date: b.createdAt.toISOString().slice(0, 10),
        amount: toNumber(b.grandTotal),
        paymentMethod: methods.length > 1 ? "Split" : methods[0] ?? "—",
        status: "Completed",
      };
    });
  });

  // ── GET /api/admin/customers/:id/payments ──────────────────────────────
  fastify.get<{ Params: { id: string } }>("/:id/payments", async (request) => {
    const admin = request.authUser!;
    const customer = await prisma.customer.findUnique({ where: { id: request.params.id } });
    if (!customer || customer.shopId !== admin.shopId) {
      throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
    }
    const txns = await prisma.creditTransaction.findMany({
      where: { shopId: admin.shopId!, customerId: customer.id, type: "COLLECTION" },
      orderBy: { createdAt: "desc" },
    });
    return txns.map((t) => ({
      id: t.id,
      date: t.createdAt.toISOString().slice(0, 10),
      amount: toNumber(t.amount),
      method: t.method ? PAYMENT_LABEL[t.method] : "Cash",
      note: t.notes ?? undefined,
    }));
  });
}
