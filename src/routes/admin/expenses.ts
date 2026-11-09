import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { Errors } from "../../lib/errors.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminExpense, paginate } from "../../lib/serializeAdmin.js";
import { toDecimal, round2, toNumber } from "../../lib/money.js";
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
  category: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(10),
});

const exportQuerySchema = querySchema.omit({ page: true, pageSize: true }).extend({
  format: z.enum(["excel", "csv"]).default("excel"),
});

/** Shared by the list endpoint and the export endpoint so filters always match what's on screen. */
function buildExpenseWhere(shopId: string, q: { search?: string; category?: string; dateFrom?: string; dateTo?: string }) {
  return {
    shopId,
    ...(q.category && q.category !== "all" ? { category: q.category } : {}),
    ...(q.dateFrom || q.dateTo
      ? { date: { ...(q.dateFrom ? { gte: new Date(q.dateFrom) } : {}), ...(q.dateTo ? { lte: new Date(q.dateTo) } : {}) } }
      : {}),
    ...(q.search
      ? { OR: [{ description: { contains: q.search, mode: "insensitive" as const } }, { category: { contains: q.search, mode: "insensitive" as const } }] }
      : {}),
  };
}

const expenseSchema = z.object({
  date: z.string().min(1),
  category: z.string().trim().min(1),
  description: z.string().trim().min(1),
  amount: z.coerce.number().positive(),
});

export default async function adminExpensesRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/expenses ────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = querySchema.parse(request.query);
    const where = buildExpenseWhere(admin.shopId!, q);

    const [items, total] = await Promise.all([
      prisma.expense.findMany({ where, orderBy: { date: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.expense.count({ where }),
    ]);

    return paginate(items.map(toAdminExpense), total, q.page, q.pageSize);
  });

  // ── GET /api/admin/expenses/export ───────────────────────────────────
  // Exports every expense matching the current filters (no pagination) as
  // an Excel or CSV file. Registered before "/:id" is irrelevant here since
  // this route file has no GET "/:id" — but kept first for readability.
  fastify.get<{ Querystring: Record<string, string> }>("/export", async (request, reply) => {
    const admin = request.authUser!;
    const q = exportQuerySchema.parse(request.query);
    const where = buildExpenseWhere(admin.shopId!, q);

    const [items, shop] = await Promise.all([
      prisma.expense.findMany({ where, include: { createdBy: true }, orderBy: { date: "desc" } }),
      prisma.shop.findUnique({ where: { id: admin.shopId! } }),
    ]);

    const columns: ExportColumn[] = [
      { key: "id", header: "Expense ID", width: 26 },
      { key: "date", header: "Date", width: 14 },
      { key: "category", header: "Category", width: 18 },
      { key: "description", header: "Description", width: 32 },
      { key: "amount", header: "Amount", width: 14 },
      { key: "createdBy", header: "Created By", width: 20 },
      { key: "createdAt", header: "Created At", width: 22 },
    ];
    const rows = items.map((e) => ({
      id: e.id,
      date: e.date.toISOString().slice(0, 10),
      category: e.category,
      description: e.description,
      amount: toNumber(e.amount),
      createdBy: e.createdBy?.name ?? "System",
      createdAt: e.createdAt.toISOString(),
    }));

    const filename = buildExportFilename(shop?.name ?? "Shop", "Expenses", extensionFor(q.format));
    const buffer =
      q.format === "csv" ? buildCsvBuffer(columns, rows) : await buildExcelBuffer("Expenses", columns, rows);

    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .type(contentTypeFor(q.format))
      .send(buffer);
  });

  // ── POST /api/admin/expenses ────────────────────────────────────────
  fastify.post("/", async (request, reply) => {
    const admin = request.authUser!;
    const body = parseBody(expenseSchema, request.body);

    const expense = await prisma.expense.create({
      data: {
        shopId: admin.shopId!,
        date: new Date(body.date),
        category: body.category,
        description: body.description,
        amount: round2(toDecimal(body.amount)),
        createdById: admin.id,
      },
    });

    await recordAudit({
      action: "EXPENSE_CREATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Expense",
      entityId: expense.id,
    });

    return reply.code(201).send(toAdminExpense(expense));
  });

  // ── PUT /api/admin/expenses/:id ──────────────────────────────────────
  fastify.put<{ Params: { id: string } }>("/:id", async (request) => {
    const admin = request.authUser!;
    const body = parseBody(expenseSchema, request.body);

    const existing = await prisma.expense.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Expense not found.", "EXPENSE_NOT_FOUND");
    }

    const updated = await prisma.expense.update({
      where: { id: existing.id },
      data: {
        date: new Date(body.date),
        category: body.category,
        description: body.description,
        amount: round2(toDecimal(body.amount)),
      },
    });

    await recordAudit({
      action: "EXPENSE_UPDATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Expense",
      entityId: updated.id,
    });

    return toAdminExpense(updated);
  });

  // ── DELETE /api/admin/expenses/:id ────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const admin = request.authUser!;
    const existing = await prisma.expense.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.shopId !== admin.shopId) {
      throw Errors.notFound("Expense not found.", "EXPENSE_NOT_FOUND");
    }
    await prisma.expense.delete({ where: { id: existing.id } });
    await recordAudit({
      action: "EXPENSE_DELETED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Expense",
      entityId: existing.id,
    });
    return reply.code(204).send();
  });
}
