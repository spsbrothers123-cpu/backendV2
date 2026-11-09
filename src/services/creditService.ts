import type { Prisma, PrismaClient, PaymentMethod } from "@prisma/client";
import { Errors } from "../lib/errors.js";
import { toDecimal, add, sub, round2 } from "../lib/money.js";

/** Records a credit sale (CREDIT-method bill) and raises the customer's
 * outstanding balance. Called inside the same transaction as bill/payment
 * creation so a credit charge is never recorded without its bill. */
export async function chargeCredit(
  tx: Prisma.TransactionClient | PrismaClient,
  input: { shopId: string; customerId: string; billId: string; amount: number; actorId?: string | null }
) {
  const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
  if (!customer || customer.shopId !== input.shopId) {
    throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
  }

  await tx.creditTransaction.create({
    data: {
      shopId: input.shopId,
      customerId: input.customerId,
      billId: input.billId,
      type: "CHARGE",
      amount: round2(toDecimal(input.amount)),
      actorId: input.actorId ?? null,
    },
  });

  await tx.customer.update({
    where: { id: input.customerId },
    data: { creditBalance: round2(add(customer.creditBalance, toDecimal(input.amount))) },
  });
}

/** Records a collection against outstanding credit. This is NOT a new
 * sale — no bill, no inventory movement, just the ledger + balance. */
export async function collectPayment(
  tx: Prisma.TransactionClient | PrismaClient,
  input: {
    shopId: string;
    customerId: string;
    amount: number;
    method?: PaymentMethod;
    reference?: string;
    notes?: string;
    actorId?: string | null;
  }
) {
  const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
  if (!customer || customer.shopId !== input.shopId) {
    throw Errors.notFound("Customer not found.", "CUSTOMER_NOT_FOUND");
  }
  if (input.amount <= 0) {
    throw Errors.validation("Collection amount must be greater than zero.");
  }
  if (round2(toDecimal(input.amount)).greaterThan(round2(customer.creditBalance))) {
    throw Errors.badRequest(
      `Collection amount exceeds outstanding balance (₹${customer.creditBalance.toFixed(2)}).`,
      "AMOUNT_EXCEEDS_BALANCE"
    );
  }

  const txn = await tx.creditTransaction.create({
    data: {
      shopId: input.shopId,
      customerId: input.customerId,
      type: "COLLECTION",
      amount: round2(toDecimal(input.amount)),
      method: input.method,
      reference: input.reference,
      notes: input.notes,
      actorId: input.actorId ?? null,
    },
  });

  const updated = await tx.customer.update({
    where: { id: input.customerId },
    data: { creditBalance: round2(sub(customer.creditBalance, toDecimal(input.amount))) },
  });

  return { txn, customer: updated };
}
