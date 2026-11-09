import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { ZERO, add, round2, toNumber } from "../lib/money.js";
import { recordAudit } from "../lib/audit.js";
import { adjustStock } from "./inventoryService.js";

/**
 * RBR Egg Mart V2 — Phase 2, Stage 2.7: bill cancellation.
 *
 * One transaction does ALL of the following or NONE of it:
 *   1. claims the bill (PAID -> CANCELLED) with a single conditional UPDATE;
 *   2. puts every line's quantity back into the bill's ORIGINAL branch;
 *   3. reverses the bill's credit charge on the customer's balance.
 *
 * Exactly-once guarantees
 *   - Step 1 is `UPDATE … WHERE id = ? AND status = 'PAID'`. Postgres row-locks
 *     the bill; a concurrent second cancel waits, then re-evaluates the WHERE
 *     against the committed CANCELLED row, matches nothing and is refused.
 *     Stock and credit are only touched by the one request that won step 1,
 *     and they roll back with it if anything later fails.
 *   - Credit reversal is additionally protected by a partial unique index
 *     (one REVERSAL per bill) as a second, database-level backstop.
 *
 * The bill, its items and its payments are never edited or deleted; unit
 * prices and totals stay exactly as sold.
 */

export interface CancelBillInput {
  billId: string;
  actorId: string;
  reason: string;
}

export interface CancelBillResult {
  id: string;
  billNumber: string | null;
  shopId: string;
  status: "CANCELLED";
  cancelledAt: Date;
  cancelledById: string;
  cancelReason: string;
  cancelledAfterSessionClose: boolean;
  grandTotal: number;
  restoredItems: { productId: string; productName: string; quantity: number }[];
  creditReversed: number;
}

export async function cancelBill(input: CancelBillInput): Promise<CancelBillResult> {
  const reason = input.reason.trim();
  if (!reason) throw Errors.validation("A reason is required to cancel a bill.");

  const result = await prisma.$transaction(
    async (tx) => {
      const bill = await tx.bill.findUnique({
        where: { id: input.billId },
        include: { items: true, session: { select: { status: true } } },
      });
      if (!bill) throw Errors.notFound("Bill not found.", "BILL_NOT_FOUND");
      if (bill.status === "CANCELLED") {
        throw Errors.conflict("This bill has already been cancelled.", "BILL_ALREADY_CANCELLED");
      }
      if (bill.status !== "PAID") {
        throw Errors.conflict("Only a completed (paid) bill can be cancelled.", "BILL_NOT_CANCELLABLE");
      }

      const afterClose = bill.session?.status === "CLOSED";
      const now = new Date();

      // 1 ── Claim the bill. Only ONE concurrent request can win this.
      const claimed = await tx.bill.updateMany({
        where: { id: bill.id, status: "PAID" },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancelledById: input.actorId,
          cancelReason: reason,
          cancelledAfterSessionClose: afterClose,
        },
      });
      if (claimed.count !== 1) {
        throw Errors.conflict("This bill has already been cancelled.", "BILL_ALREADY_CANCELLED");
      }

      // 2 ── Restore stock to the bill's own branch. Lines are merged per
      // product and applied in productId order (consistent lock order).
      const perProduct = new Map<string, { productName: string; quantity: number }>();
      for (const it of bill.items) {
        const cur = perProduct.get(it.productId);
        perProduct.set(it.productId, { productName: it.productName, quantity: (cur?.quantity ?? 0) + it.quantity });
      }
      const restoredItems: CancelBillResult["restoredItems"] = [];
      for (const productId of [...perProduct.keys()].sort()) {
        const { productName, quantity } = perProduct.get(productId)!;
        await adjustStock(tx, {
          shopId: bill.shopId, // the ORIGINAL branch, never the admin's selected one
          cashierId: bill.cashierId, // owner pre-cutover; actor metadata after
          productId,
          delta: quantity,
          type: "IN",
          reason: `BILL_CANCELLED:${bill.billNumber ?? bill.id}`,
          actorId: input.actorId,
          allowUnassigned: true,
        });
        restoredItems.push({ productId, productName, quantity });
      }

      // 3 ── Reverse the credit charge (if the bill had one).
      const charges = await tx.creditTransaction.findMany({
        where: { billId: bill.id, type: "CHARGE" },
      });
      let creditReversed = ZERO;
      for (const c of charges) creditReversed = add(creditReversed, c.amount);
      creditReversed = round2(creditReversed);

      if (charges.length > 0 && creditReversed.greaterThan(0)) {
        const customerId = charges[0]!.customerId;
        // Atomic conditional decrement: never drives the balance below zero.
        const dec = await tx.customer.updateMany({
          where: { id: customerId, creditBalance: { gte: creditReversed } },
          data: { creditBalance: { decrement: creditReversed } },
        });
        if (dec.count !== 1) {
          throw Errors.conflict(
            "This credit bill can't be cancelled automatically: the customer has already paid down part of their balance, " +
              "so reversing the full credit would leave a negative balance. Resolve the customer's payments first.",
            "CREDIT_REVERSAL_EXCEEDS_BALANCE"
          );
        }
        await tx.creditTransaction.create({
          data: {
            shopId: bill.shopId,
            customerId,
            billId: bill.id,
            type: "REVERSAL",
            amount: creditReversed,
            notes: `Bill ${bill.billNumber ?? bill.id} cancelled: ${reason}`,
            actorId: input.actorId,
          },
        });
      }

      return {
        id: bill.id,
        billNumber: bill.billNumber,
        shopId: bill.shopId,
        status: "CANCELLED" as const,
        cancelledAt: now,
        cancelledById: input.actorId,
        cancelReason: reason,
        cancelledAfterSessionClose: afterClose,
        grandTotal: toNumber(bill.grandTotal),
        restoredItems,
        creditReversed: toNumber(creditReversed),
      };
    },
    { timeout: 15_000, maxWait: 10_000 }
  );

  await recordAudit({
    action: "BILL_CANCELLED",
    actorId: input.actorId,
    actorRole: "ADMIN",
    shopId: result.shopId,
    entityType: "Bill",
    entityId: result.id,
    metadata: {
      billNumber: result.billNumber,
      reason: result.cancelReason,
      grandTotal: result.grandTotal,
      creditReversed: result.creditReversed,
      cancelledAfterSessionClose: result.cancelledAfterSessionClose,
      restoredItems: result.restoredItems,
    },
  });

  return result;
}
