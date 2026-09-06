import { prisma } from "../lib/prisma.js";
import { toNumber } from "../lib/money.js";

/**
 * Computes a session's live sales summary straight from PAID bills +
 * payments in the database. Used by both the cashier app (session
 * current/close screens) and the admin app (active/history session
 * views) — one query, one source of truth, no drift between the two.
 */
export async function summarizeSession(sessionId: string) {
  const bills = await prisma.bill.findMany({
    where: { sessionId, status: "PAID" },
    include: { payments: true },
  });

  const summary = { sales: 0, billCount: bills.length, cashSales: 0, cardSales: 0, upiSales: 0, creditSales: 0 };
  for (const bill of bills) {
    summary.sales += toNumber(bill.grandTotal);
    for (const p of bill.payments) {
      if (p.method === "CASH") summary.cashSales += toNumber(p.amount);
      else if (p.method === "CARD") summary.cardSales += toNumber(p.amount);
      else if (p.method === "UPI") summary.upiSales += toNumber(p.amount);
      else if (p.method === "CREDIT") summary.creditSales += toNumber(p.amount);
    }
  }
  return summary;
}
