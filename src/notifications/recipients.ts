import type { Prisma, PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

type Db = Prisma.TransactionClient | PrismaClient;

/**
 * D-02: the Central Admin is the ONLY Admin recipient — identified solely by
 * CENTRAL_ADMIN_USER_ID, never by role, email or the selected shop. Fails
 * closed: unset id, or an id that is not an ACTIVE ADMIN, yields no recipients
 * (other ADMIN accounts can never receive central notifications).
 */
export async function resolveCentralAdminRecipients(db: Db): Promise<string[]> {
  const id = env.CENTRAL_ADMIN_USER_ID;
  if (!id) return [];
  const admin = await db.user.findFirst({ where: { id, role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  return admin ? [admin.id] : [];
}

/** The branch's ACTIVE Cashier(s) — exactly one by design (Stage 2.4); never client-supplied. */
export async function resolveBranchCashierRecipients(db: Db, shopId: string): Promise<string[]> {
  const rows = await db.user.findMany({ where: { shopId, role: "CASHIER", status: "ACTIVE" }, select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * D-14: credit alerts go only to the Cashier who OWNS the customer
 * (Customer.cashierId), and only while that Cashier is ACTIVE at the same
 * branch. Admin-created / unowned customers notify no Cashier.
 */
export async function resolveCustomerOwnerRecipients(db: Db, shopId: string, customerId: string): Promise<string[]> {
  const customer = await db.customer.findFirst({ where: { id: customerId, shopId }, select: { cashierId: true } });
  if (!customer?.cashierId) return [];
  const owner = await db.user.findFirst({
    where: { id: customer.cashierId, shopId, role: "CASHIER", status: "ACTIVE" },
    select: { id: true },
  });
  return owner ? [owner.id] : [];
}
