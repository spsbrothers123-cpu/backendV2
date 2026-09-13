/**
 * Shapes here are dictated by Cashier2_0/src/types/index.js JSDoc typedefs
 * (Product, Customer, CartItem, HeldBill, Payment, Bill, Session,
 * SessionSummary, SalesReport) — NOT by internal Prisma model shapes.
 */
import type {
  Product,
  Customer,
  Bill,
  BillItem,
  Payment,
  CashierSession,
  Shop,
} from "@prisma/client";
import { toNumber } from "./money.js";

const UNIT_MAP: Record<string, string> = {
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

const METHOD_MAP: Record<string, string> = { CASH: "cash", CARD: "card", UPI: "upi", CREDIT: "credit" };
export const METHOD_MAP_REVERSE: Record<string, string> = { cash: "CASH", card: "CARD", upi: "UPI", credit: "CREDIT" };

/**
 * `cashierStock`, when provided, overrides `stock` with the AUTHENTICATED
 * cashier's own CashierInventory quantity for this product — required for
 * any live "what can I sell right now" view (POS browse/search), per the
 * cashier-level inventory isolation requirement: a cashier must only ever
 * see their own stock, never the shop-wide total (p.stock).
 *
 * Omitted (falls back to p.stock) only for historical/snapshot contexts —
 * receipts, held-bill line items, bill history — where the number is
 * informational display of a past line item, not a live "can I sell this"
 * check, so the shop-wide aggregate is an acceptable snapshot value.
 */
export function toCashierProduct(p: Product, cashierStock?: number): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku ?? undefined,
    barcode: p.barcode ?? undefined,
    category: p.category,
    price: toNumber(p.sellingPrice),
    unit: UNIT_MAP[p.unit] ?? p.unit.toLowerCase(),
    stock: cashierStock ?? p.stock,
  };
}

export function toCashierCustomer(c: Customer): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    creditBalance: toNumber(c.creditBalance),
  };
}

type BillWithRelations = Bill & {
  items: (BillItem & { product: Product })[];
  payments: Payment[];
  customer: Customer | null;
  shop?: Shop;
  cashier?: { name: string };
};

export function toCashierBill(b: BillWithRelations): Record<string, unknown> {
  return {
    id: b.id,
    billNumber: b.billNumber,
    shopId: b.shopId,
    cashierId: b.cashierId,
    cashierName: b.cashier?.name,
    sessionId: b.sessionId,
    customer: b.customer ? toCashierCustomer(b.customer) : null,
    items: b.items.map((it) => ({
      product: toCashierProduct(it.product),
      quantity: it.quantity,
      // The actual price charged for this line (may be a bill-only
      // override) — never the live catalog price, so receipts/history
      // stay accurate even if the product is later re-priced.
      unitPrice: toNumber(it.unitPrice),
    })),
    subtotal: toNumber(b.subtotal),
    discount: toNumber(b.discount),
    tax: toNumber(b.tax),
    grandTotal: toNumber(b.grandTotal),
    payments: b.payments.map((p) => ({
      method: METHOD_MAP[p.method] ?? p.method.toLowerCase(),
      amount: toNumber(p.amount),
      reference: p.reference ?? undefined,
      cashReceived: p.cashReceived != null ? toNumber(p.cashReceived) : undefined,
      change: p.change != null ? toNumber(p.change) : undefined,
    })),
    status: b.status === "PAID" ? "paid" : b.status.toLowerCase(),
    createdAt: b.createdAt.toISOString(),
    idempotencyKey: b.idempotencyKey ?? undefined,
  };
}

export function toHeldBill(b: BillWithRelations): Record<string, unknown> {
  return {
    id: b.id,
    label: b.label ?? "Held bill",
    customer: b.customer ? toCashierCustomer(b.customer) : null,
    items: b.items.map((it) => ({
      product: toCashierProduct(it.product),
      quantity: it.quantity,
      unitPrice: toNumber(it.unitPrice),
    })),
    amount: toNumber(b.grandTotal),
    shopId: b.shopId,
    heldAt: (b.heldAt ?? b.createdAt).toISOString(),
  };
}

export function toCashierSession(s: CashierSession): Record<string, unknown> {
  return {
    id: s.id,
    cashierId: s.cashierId,
    shopId: s.shopId,
    status: s.status === "OPEN" ? "active" : "closed",
    startedAt: s.openedAt.toISOString(),
    openingCash: toNumber(s.openingCash),
    closedAt: s.closedAt ? s.closedAt.toISOString() : undefined,
    actualClosingCash: s.actualClosingCash != null ? toNumber(s.actualClosingCash) : undefined,
  };
}
