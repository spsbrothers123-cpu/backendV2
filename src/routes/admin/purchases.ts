import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminPurchase, paginate, UNIT_MAP, UNIT_MAP_REVERSE } from "../../lib/serializeAdmin.js";
import { toDecimal, add, mul, round2, ZERO, toNumber } from "../../lib/money.js";
import { adjustStock } from "../../services/inventoryService.js";
import { Errors } from "../../lib/errors.js";
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
function buildPurchaseWhere(shopId: string, q: { search?: string }) {
  return {
    shopId,
    ...(q.search
      ? { OR: [{ supplierName: { contains: q.search, mode: "insensitive" as const } }, { invoiceNumber: { contains: q.search, mode: "insensitive" as const } }] }
      : {}),
  };
}

const purchaseSchema = z.object({
  supplierName: z.string().trim().min(1),
  invoiceNumber: z.string().trim().min(1),
  purchaseDate: z.string().min(1),
  items: z
    .array(
      z.object({
        // Present -> Option 1, "Add Product in Catalog": references a real
        // Product, must belong to the admin's shop, and increases its
        // stock. Absent/empty -> Option 2, "Add to Purchase List — Not in
        // Catalog": a one-time line item that only ever lives on this
        // purchase (see PurchaseItem.productId in schema.prisma).
        productId: z.string().trim().min(1).optional(),
        productName: z.string().trim().min(1),
        quantity: z.coerce.number().positive(),
        unit: z.enum(["kg", "g", "litre", "ml", "piece", "tray", "box"]),
        purchasePrice: z.coerce.number().nonnegative(),
      })
    )
    .min(1, "A purchase needs at least one item."),
});

export default async function adminPurchasesRoutes(fastify: FastifyInstance) {
  fastify.addHook("preHandler", fastify.requireRole("ADMIN"));

  // ── GET /api/admin/purchases ────────────────────────────────────────
  fastify.get<{ Querystring: Record<string, string> }>("/", async (request) => {
    const admin = request.authUser!;
    const q = querySchema.parse(request.query);
    const where = buildPurchaseWhere(admin.shopId!, q);

    const [items, total] = await Promise.all([
      prisma.purchase.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: "desc" },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      prisma.purchase.count({ where }),
    ]);

    return paginate(items.map(toAdminPurchase), total, q.page, q.pageSize);
  });

  // ── GET /api/admin/purchases/export ───────────────────────────────────
  // Exports every purchase matching the current search filter (no
  // pagination) as an Excel or CSV file — one row per purchase, with a
  // summarized line-items column (a real Excel/CSV row can't hold a
  // one-to-many relation as its own rows without duplicating the parent).
  fastify.get<{ Querystring: Record<string, string> }>("/export", async (request, reply) => {
    const admin = request.authUser!;
    const q = exportQuerySchema.parse(request.query);
    const where = buildPurchaseWhere(admin.shopId!, q);

    const [items, shop] = await Promise.all([
      prisma.purchase.findMany({
        where,
        include: { items: true, createdBy: true },
        orderBy: { createdAt: "desc" },
      }),
      prisma.shop.findUnique({ where: { id: admin.shopId! } }),
    ]);

    const columns: ExportColumn[] = [
      { key: "id", header: "Purchase ID", width: 26 },
      { key: "invoiceNumber", header: "Invoice Number", width: 18 },
      { key: "supplierName", header: "Supplier", width: 24 },
      { key: "purchaseDate", header: "Purchase Date", width: 14 },
      { key: "items", header: "Items", width: 45 },
      { key: "subtotal", header: "Subtotal", width: 14 },
      { key: "tax", header: "Tax", width: 12 },
      { key: "grandTotal", header: "Grand Total", width: 14 },
      { key: "status", header: "Status", width: 12 },
      { key: "createdBy", header: "Created By", width: 20 },
      { key: "createdAt", header: "Created At", width: 22 },
    ];
    const rows = items.map((p) => ({
      id: p.id,
      invoiceNumber: p.invoiceNumber,
      supplierName: p.supplierName,
      purchaseDate: p.purchaseDate.toISOString().slice(0, 10),
      items: p.items.map((it) => `${it.productName} x${it.quantity} ${UNIT_MAP[it.unit] ?? it.unit.toLowerCase()}`).join("; "),
      subtotal: toNumber(p.subtotal),
      tax: toNumber(p.tax),
      grandTotal: toNumber(p.grandTotal),
      status: p.status.charAt(0) + p.status.slice(1).toLowerCase(),
      createdBy: p.createdBy?.name ?? "System",
      createdAt: p.createdAt.toISOString(),
    }));

    const filename = buildExportFilename(shop?.name ?? "Shop", "Purchases", extensionFor(q.format));
    const buffer =
      q.format === "csv" ? buildCsvBuffer(columns, rows) : await buildExcelBuffer("Purchases", columns, rows);

    return reply
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .type(contentTypeFor(q.format))
      .send(buffer);
  });

  // ── POST /api/admin/purchases ────────────────────────────────────────
  // Transactional: creates the purchase + line items and increases stock
  // for every product in one atomic operation.
  fastify.post("/", async (request, reply) => {
    const admin = request.authUser!;
    const body = parseBody(purchaseSchema, request.body);

    // Split once: catalog items (real productId, must resolve against this
    // shop's Product Catalog and move stock) vs purchase-only items (no
    // productId — never touch Product or inventory). Every item still
    // contributes to the purchase's totals and gets its own persisted row.
    const catalogItems = body.items.filter((i) => !!i.productId);
    const purchaseOnlyItems = body.items.filter((i) => !i.productId);

    const productIds = [...new Set(catalogItems.map((i) => i.productId!))];
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, shopId: admin.shopId! } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    for (const item of catalogItems) {
      if (!productMap.has(item.productId!)) {
        throw Errors.notFound(`Product not found: ${item.productId}`, "PRODUCT_NOT_FOUND");
      }
    }

    let subtotal = ZERO;
    for (const item of body.items) subtotal = add(subtotal, mul(toDecimal(item.purchasePrice), item.quantity));
    subtotal = round2(subtotal);
    const grandTotal = subtotal; // No purchase tax rules defined yet.

    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          shopId: admin.shopId!,
          supplierName: body.supplierName,
          invoiceNumber: body.invoiceNumber,
          purchaseDate: new Date(body.purchaseDate),
          subtotal,
          tax: ZERO,
          grandTotal,
          status: "RECEIVED",
          createdById: admin.id,
          items: {
            create: body.items.map((item) => ({
              // undefined (not present) for purchase-only items — Prisma
              // leaves the nullable FK column null, exactly the
              // "no productId => not in catalog" marker the schema uses.
              productId: item.productId ?? undefined,
              productName: item.productName,
              quantity: item.quantity,
              unit: UNIT_MAP_REVERSE[item.unit] as never,
              purchasePrice: round2(toDecimal(item.purchasePrice)),
              total: round2(mul(toDecimal(item.purchasePrice), item.quantity)),
            })),
          },
        },
        include: { items: true },
      });

      // Only catalog items move stock. Purchase-only items were never in
      // the Product Catalog to begin with, so there is no product to
      // adjust — and none should be created here (Option 2 explicitly
      // never creates a Product row).
      for (const item of catalogItems) {
        await adjustStock(tx, {
          shopId: admin.shopId!,
          productId: item.productId!,
          delta: item.quantity,
          type: "IN",
          reason: `Purchase ${body.invoiceNumber} — ${body.supplierName}`,
          actorId: admin.id,
        });
      }

      return created;
    });

    await recordAudit({
      action: "PURCHASE_CREATED",
      actorId: admin.id,
      actorRole: "ADMIN",
      shopId: admin.shopId,
      entityType: "Purchase",
      entityId: purchase.id,
      metadata: { invoiceNumber: purchase.invoiceNumber, purchaseOnlyItemCount: purchaseOnlyItems.length },
    });

    return reply.code(201).send(toAdminPurchase(purchase));
  });
}
