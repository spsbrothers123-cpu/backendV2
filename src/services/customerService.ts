import { PrismaClientKnownRequestError } from "@prisma/client/runtime/library.js";
import { prisma } from "../lib/prisma.js";
import { Errors } from "../lib/errors.js";
import { recordAudit } from "../lib/audit.js";
import type { Role } from "@prisma/client";

export interface CreateCustomerInput {
  shopId: string;
  name: string;
  phone: string;
  actorId: string;
  actorRole: Role;
  // Phase 3 cashier data isolation: set when a CASHIER creates this
  // customer, so it lands in that cashier's own scope (see
  // routes/customers.ts). Admin-created customers (routes/admin/customers.ts)
  // never pass this — they stay unassigned/shop-wide, visible to every
  // cashier's admin oversight but not claimed by any one cashier.
  cashierId?: string | null;
}

/**
 * Single write path for customer creation, shared by the Cashier
 * (POST /api/customers) and Admin (POST /api/admin/customers) endpoints.
 * There is exactly one `customers` table — a customer created by a
 * cashier IS the same row an admin sees on the Customers page, scoped to
 * the same shop. Since Phase 3, it's also scoped to the creating cashier
 * (see Customer @@unique([shopId, cashierId, phone]) in schema.prisma) —
 * Admin still sees every customer in the shop regardless of cashierId;
 * only the Cashier-facing endpoints filter by it.
 *
 * shopId and cashierId must always come from the authenticated user
 * (request.authUser), never from the request body, so a cashier/admin can
 * never create or collide with another shop's — or another cashier's —
 * customers.
 */
export async function createCustomerForShop(input: CreateCustomerInput) {
  try {
    const customer = await prisma.customer.create({
      data: { shopId: input.shopId, name: input.name, phone: input.phone, cashierId: input.cashierId ?? null },
    });

    await recordAudit({
      action: "CUSTOMER_CREATED",
      actorId: input.actorId,
      actorRole: input.actorRole,
      shopId: input.shopId,
      entityType: "Customer",
      entityId: customer.id,
    });

    return customer;
  } catch (err) {
    // Unique constraint on [shopId, phone] — this shop already has a
    // customer with this phone number. Surface a clear, actionable 409
    // instead of a raw DB error, and never create a second row for the
    // same shop+phone (Backend spec §2/§8: prevent duplicate customers).
    if (err instanceof PrismaClientKnownRequestError && err.code === "P2002") {
      throw Errors.conflict(
        "A customer with this phone number already exists for this shop.",
        "CUSTOMER_ALREADY_EXISTS"
      );
    }
    throw err;
  }
}
