import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { parseBody } from "../../lib/validate.js";
import { recordAudit } from "../../lib/audit.js";
import { toAdminPurchase, paginate, UNIT_MAP, UNIT_MAP_REVERSE } from "../../lib/serializeAdmin.js";
import { toDecimal, add, mul, round2, ZERO, toNumber } from "../../lib/money.js";
import { adjustStock } from "../../services/inventoryService.js";
import { AppError, Errors } from "../../lib/errors.js";
import {
  buildCsvBuffer,
  buildExcelBuffer,
  buildExportFilename,
  contentTypeFor,
  extensionFor,
  type ExportColumn,
} from "../../services/exportService.js";
import { assignedToShop } from "../../lib/branchCatalog.js";
import { resolveStockCashier } from "../../lib/stockActor.js";
import { centralAdminOnly } from "../../lib/centralAdmin.js";

const reverseSchema = z.object({
  // Mandatory: the audit trail must say why stock was taken back out.
  reason: z.string().trim().min(3, "A reason is required to reverse a purchase.").max(500),
  // CASHIER mode (pre-cutover) only: whose legacy inventory to deduct from.
  cashierId: z.string().trim().min(1).optional(),
});

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
  // Before the BranchInventory cutover (Stage 2.3) stock is cashier-owned:
  // every catalog item increases THIS cashier's own inventory, so the id is
  // required. After the cutover stock belongs to the branch and this is
  // optional actor metadata. Enforced by resolveStockCashier().
  cashierId: z.string().trim().min(1).optional(),
  // Stage 2.6: the receiving branch is chosen EXPLICITLY by the Central
  // Admin. It is never inferred from the Global Shop Selector, so changing
  // the selector later cannot affect this (or any existing) purchase.
  receivingShopId: z.string().trim().min(1, "Select the receiving branch."),
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
        include: { items: true, reversal: true, shop: { select: { name: true } } },
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
        include: { items: true, createdBy: true, reversal: true, shop: { select: { name: true } } },
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
      { key: "receivingBranch", header: "Receiving Branch", width: 22 },
      { key: "reversal", header: "Reversal", width: 30 },
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
      receivingBranch: p.shop?.name ?? "",
      reversal: p.reversal ? `Reversed: ${p.reversal.reason}` : "",
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
  fastify.post("/", { preHandler: centralAdminOnly("record purchases") }, async (request, reply) => {
    const admin = request.authUser!;
    const body = parseBody(purchaseSchema, request.body);

    // Explicit receiving branch — must exist. Stock goes ONLY here.
    const receivingShop = await prisma.shop.findUnique({ where: { id: body.receivingShopId } });
    if (!receivingShop) throw Errors.notFound("Receiving branch not found.", "SHOP_NOT_FOUND");
    const receivingShopId = receivingShop.id;

    // Never trust the admin-selected cashierId at face value — confirm it
    // actually belongs to the RECEIVING branch before any stock moves.
    const stockCashierId = await resolveStockCashier(receivingShopId, body.cashierId);

    const catalogItems = body.items.filter((i) => !!i.productId);
    const purchaseOnlyItems = body.items.filter((i) => !i.productId);

    const productIds = [...new Set(catalogItems.map((i) => i.productId!))];
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, ...assignedToShop(receivingShopId) } });
    const productMap = new Map(products.map((p) => [p.id, p]));
    for (const item of catalogItems) {
      if (!productMap.has(item.productId!)) {
        throw Errors.notFound(`Product not found at the receiving branch: ${item.productId}`, "PRODUCT_NOT_FOUND");
      }
    }

    let subtotal = ZERO;
    for (const item of body.items) subtotal = add(subtotal, mul(toDecimal(item.purchasePrice), item.quantity));
    subtotal = round2(subtotal);
    const grandTotal = subtotal; // No purchase tax rules defined yet.

    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          shopId: receivingShopId, // persisted receiving branch (immutable)
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
        include: { items: true, reversal: true, shop: { select: { name: true } } },
      });

      // Only catalog items move stock. Purchase-only items were never in
      // the Product Catalog to begin with, so there is no product to
      // adjust — and none should be created here (Option 2 explicitly
      // never creates a Product row).
      for (const item of catalogItems) {
        await adjustStock(tx, {
          shopId: receivingShopId,
          cashierId: stockCashierId,
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
      shopId: receivingShopId,
      entityType: "Purchase",
      entityId: purchase.id,
      metadata: { invoiceNumber: purchase.invoiceNumber, purchaseOnlyItemCount: purchaseOnlyItems.length, cashierId: stockCashierId },
    });

    return reply.code(201).send(toAdminPurchase(purchase));
  });

  // ── POST /api/admin/purchases/:id/reverse ─────────────────────────────
  // Stage 2.6: the ONLY way to correct a completed purchase. Central Admin
  // only; independent of the Global Shop Selector (acts on the purchase's own
  // receiving branch). In ONE transaction it records a linked reversal and
  // takes the received quantities back out of that branch's stock (negative
  // OUT movements). The original purchase, its items and its history are
  // never edited or deleted. Blocked — with nothing written — if any item
  // would drive the branch's stock negative. A purchase can be reversed once.
  fastify.post<{ Params: { id: string } }>(
    "/:id/reverse",
    { preHandler: centralAdminOnly("reverse purchases") },
    async (request) => {
      const admin = request.authUser!;
      const body = parseBody(reverseSchema, request.body);

      const purchase = await prisma.purchase.findUnique({
        where: { id: request.params.id },
        include: { items: true, reversal: true },
      });
      if (!purchase) throw Errors.notFound("Purchase not found.", "PURCHASE_NOT_FOUND");
      if (purchase.reversal) throw Errors.conflict("This purchase has already been reversed.", "PURCHASE_ALREADY_REVERSED");
      if (purchase.status !== "RECEIVED") {
        throw Errors.conflict("Only a received purchase can be reversed.", "PURCHASE_NOT_REVERSIBLE");
      }

      const stockCashierId = await resolveStockCashier(purchase.shopId, body.cashierId);
      const catalogItems = purchase.items.filter((i) => !!i.productId);

      try {
        await prisma.$transaction(async (tx) => {
          // Unique(purchaseId): a concurrent/duplicate reversal fails right
          // here (P2002), before any stock is touched.
          await tx.purchaseReversal.create({
            data: { purchaseId: purchase.id, reason: body.reason, reversedById: admin.id },
          });
          for (const item of catalogItems) {
            try {
              await adjustStock(tx, {
                shopId: purchase.shopId,
                cashierId: stockCashierId,
                productId: item.productId!,
                delta: -item.quantity,
                type: "OUT",
                reason: `Reversal of purchase ${purchase.invoiceNumber} — ${body.reason}`,
                actorId: admin.id,
              });
            } catch (err) {
              if (err instanceof AppError && err.code === "INSUFFICIENT_STOCK") {
                throw Errors.conflict(
                  `Cannot reverse: removing ${item.quantity} of "${item.productName}" would make this branch's stock negative. ${err.message}`,
                  "PURCHASE_REVERSAL_BLOCKED"
                );
              }
              if (err instanceof AppError && err.code === "PRODUCT_NOT_FOUND") {
                throw Errors.conflict(
                  `Cannot reverse: "${item.productName}" is not currently assigned to the receiving branch. Re-assign it (its stock is preserved) and try again.`,
                  "PURCHASE_REVERSAL_BLOCKED"
                );
              }
              throw err;
            }
          }
        });
      } catch (err) {
        if (typeof err === "object" && err && (err as { code?: string }).code === "P2002") {
          throw Errors.conflict("This purchase has already been reversed.", "PURCHASE_ALREADY_REVERSED");
        }
        throw err;
      }

      await recordAudit({
        action: "PURCHASE_REVERSED",
        actorId: admin.id,
        actorRole: "ADMIN",
        shopId: purchase.shopId,
        entityType: "Purchase",
        entityId: purchase.id,
        metadata: { invoiceNumber: purchase.invoiceNumber, reason: body.reason, reversedItemCount: catalogItems.length, cashierId: stockCashierId },
      });

      const fresh = await prisma.purchase.findUniqueOrThrow({
        where: { id: purchase.id },
        include: { items: true, reversal: true, shop: { select: { name: true } } },
      });
      return toAdminPurchase(fresh);
    }
  );
}
