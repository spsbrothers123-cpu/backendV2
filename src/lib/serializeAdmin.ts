/**
 * Shapes here are dictated by Admin2_0/src/types/index.ts — NOT by
 * internal Prisma model shapes.
 */
import type {
  Product,
  Purchase,
  PurchaseItem,
  Expense,
  InventoryMovement,
  CashierSession,
  User,
  Notification,
  Shop,
  ShopSettings,
} from "@prisma/client";
import { toNumber } from "./money.js";

export const UNIT_MAP: Record<string, string> = {
  KG: "kg",
  G: "g",
  LITRE: "litre",
  ML: "ml",
  PIECE: "piece",
  TRAY: "tray",
  BOX: "box",
};
export const UNIT_MAP_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(UNIT_MAP).map(([k, v]) => [v, k])
);

export const PAYMENT_LABEL: Record<string, string> = { CASH: "Cash", CARD: "Card", UPI: "UPI", CREDIT: "Credit" };

export function paginate<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, total, page, pageSize };
}

export function toAdminProduct(p: Product): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    sellingPrice: toNumber(p.sellingPrice),
    costPrice: p.costPrice != null ? toNumber(p.costPrice) : undefined,
    stock: p.stock,
    unit: UNIT_MAP[p.unit] ?? p.unit.toLowerCase(),
    lowStockThreshold: p.lowStockThreshold,
    status: p.status === "ACTIVE" ? "active" : "inactive",
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function productStatusLabel(p: { stock: number; lowStockThreshold: number }): "In Stock" | "Low Stock" | "Out of Stock" {
  if (p.stock <= 0) return "Out of Stock";
  if (p.stock <= p.lowStockThreshold) return "Low Stock";
  return "In Stock";
}

export function toAdminCustomer(c: {
  id: string;
  name: string;
  phone: string;
  creditBalance: unknown;
  createdAt: Date;
  totalPurchases: number;
  billCount: number;
}): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    totalPurchases: c.totalPurchases,
    billCount: c.billCount,
    creditBalance: toNumber(c.creditBalance as never),
    createdAt: c.createdAt.toISOString(),
  };
}

export function toAdminPurchase(p: Purchase & { items: PurchaseItem[] }): Record<string, unknown> {
  return {
    id: p.id,
    invoiceNumber: p.invoiceNumber,
    supplierName: p.supplierName,
    purchaseDate: p.purchaseDate.toISOString().slice(0, 10),
    items: p.items.map((it) => ({
      id: it.id,
      // null -> a Phase 2 "purchase-only" item (Option 2: "Add to Purchase
      // List — Not in Catalog"). Never a real Product row, never shown in
      // the Product Catalog or Cashier POS.
      productId: it.productId,
      inCatalog: it.productId != null,
      productName: it.productName,
      quantity: it.quantity,
      unit: UNIT_MAP[it.unit] ?? it.unit.toLowerCase(),
      purchasePrice: toNumber(it.purchasePrice),
      total: toNumber(it.total),
    })),
    subtotal: toNumber(p.subtotal),
    tax: toNumber(p.tax),
    grandTotal: toNumber(p.grandTotal),
    status: p.status.charAt(0) + p.status.slice(1).toLowerCase(),
  };
}

export function toAdminExpense(e: Expense): Record<string, unknown> {
  return {
    id: e.id,
    date: e.date.toISOString().slice(0, 10),
    category: e.category,
    description: e.description,
    amount: toNumber(e.amount),
    createdBy: e.createdById ?? "System",
  };
}

export function toStockMovement(m: InventoryMovement & { product: Product; actor?: User | null }): Record<string, unknown> {
  return {
    id: m.id,
    date: m.createdAt.toISOString(),
    productId: m.productId,
    productName: m.product.name,
    type: m.type,
    quantity: m.quantity,
    previousStock: m.previousStock,
    newStock: m.newStock,
    reason: m.reason,
    user: m.actor?.name ?? "System",
  };
}

export function toActiveSession(
  s: CashierSession & { cashier: User; shop: { name: string } },
  summary: { sales: number; cashSales: number; upiSales: number; cardSales: number; creditSales: number }
): Record<string, unknown> {
  const expectedClosingCash = toNumber(s.openingCash) + summary.cashSales;
  return {
    id: s.id,
    cashier: s.cashier.name,
    shop: s.shop.name,
    openingTime: s.openedAt.toISOString(),
    openingCash: toNumber(s.openingCash),
    sales: summary.sales,
    cashSales: summary.cashSales,
    upiSales: summary.upiSales,
    cardSales: summary.cardSales,
    creditSales: summary.creditSales,
    expectedClosingCash,
    actualClosingCash: s.actualClosingCash != null ? toNumber(s.actualClosingCash) : null,
    cashDifference: s.actualClosingCash != null ? toNumber(s.actualClosingCash) - expectedClosingCash : null,
    status: s.status === "OPEN" ? "Open" : "Closed",
  };
}

export function toSessionHistoryItem(
  s: CashierSession & { cashier: User; shop: { name: string } },
  summary: { sales: number; cashSales: number }
): Record<string, unknown> {
  const expected = toNumber(s.openingCash) + summary.cashSales;
  const closingCash = s.actualClosingCash != null ? toNumber(s.actualClosingCash) : 0;
  return {
    id: s.id,
    cashier: s.cashier.name,
    // Sessions spans every shop the admin owns (Phase 3 spec §2) — the Shop
    // column lets the Admin tell apart same-named cashiers at different
    // shops without this needing to double as the row's authorization scope.
    shop: s.shop.name,
    openingTime: s.openedAt.toISOString(),
    closingTime: s.closedAt ? s.closedAt.toISOString() : "",
    openingCash: toNumber(s.openingCash),
    closingCash,
    sales: summary.sales,
    cashDifference: s.actualClosingCash != null ? closingCash - expected : 0,
    status: s.status === "OPEN" ? "Open" : "Closed",
  };
}

// ── Notifications ────────────────────────────────────────────────────
export const NOTIFICATION_TYPE_MAP: Record<string, string> = {
  LOW_STOCK: "low_stock",
  PAYMENT_PENDING: "payment_pending",
  SESSION_EVENT: "session_event",
  SYSTEM: "system",
};

export function toAdminNotification(n: Notification): Record<string, unknown> {
  return {
    id: n.id,
    type: NOTIFICATION_TYPE_MAP[n.type] ?? "system",
    title: n.title,
    message: n.message,
    time: n.createdAt.toISOString(),
    read: n.read,
  };
}

// ── Admin profile ────────────────────────────────────────────────────
export function toAdminProfile(user: User): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: "admin",
    lastLogin: (user.lastLoginAt ?? user.createdAt).toISOString(),
  };
}

// ── Settings ─────────────────────────────────────────────────────────
// Defaults mirror the Admin app's mock store (src/api/mockStore.ts) so a
// shop that has never saved settings still sees sensible values.
const DEFAULT_TAX_BILLING = { gstEnabled: false, gstPercentage: 0, invoicePrefix: "INV", invoiceFooterNote: "" };
const DEFAULT_APPEARANCE = { theme: "system", productDisplay: "grid" };
const DEFAULT_POS = { receiptFooter: "", printerName: "", autoPrintReceipt: false, invoiceFormat: "A4" };
const DEFAULT_SECURITY = { sessionTimeoutMinutes: 30, requireConfirmationForRefunds: true };

export function toShopSettings(shop: Shop, settings: ShopSettings | null): Record<string, unknown> {
  return {
    shopName: shop.name,
    address: shop.address ?? "",
    gstin: settings?.gstin ?? "",
    phone: settings?.contactPhone ?? "",
    email: settings?.contactEmail ?? "",
  };
}

export function toTaxBillingSettings(settings: ShopSettings | null): Record<string, unknown> {
  return { ...DEFAULT_TAX_BILLING, ...((settings?.taxBilling as object) ?? {}) };
}

export function toAppearanceSettings(settings: ShopSettings | null): Record<string, unknown> {
  return { ...DEFAULT_APPEARANCE, ...((settings?.appearance as object) ?? {}) };
}

export function toPosSettings(settings: ShopSettings | null): Record<string, unknown> {
  return { ...DEFAULT_POS, ...((settings?.pos as object) ?? {}) };
}

export function toSecuritySettings(settings: ShopSettings | null): Record<string, unknown> {
  return { ...DEFAULT_SECURITY, ...((settings?.security as object) ?? {}) };
}
