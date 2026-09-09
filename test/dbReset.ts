import { prisma } from "../src/lib/prisma.js";

/**
 * Full DB wipe between integration tests, shared by every
 * test/*.integration.test.ts file.
 *
 * Order matters: every model here must be cleared before any model it
 * holds a foreign key to. Only a handful of relations in
 * prisma/schema.prisma cascade on delete (AdminShopLink, Session.userId,
 * BillItem/Payment.billId, PurchaseItem.purchaseId) — everything else
 * (every shopId/actorId/cashierId/createdById FK) has no onDelete set, so
 * Postgres throws a foreign key constraint violation on the final
 * user/shop deleteMany() below unless its children are already gone.
 *
 * This used to be copy-pasted per test file, and every copy had silently
 * fallen out of sync with the schema (missing shopSettings, notification,
 * purchase/purchaseItem, expense — any test that touched those routes
 * would leave a row behind that wedges every later beforeEach with
 * "Foreign key constraint violated" until the DB is manually cleared).
 * One shared function here means new models only need to be added once.
 *
 * Keep this in sync with prisma/schema.prisma: a new model with a
 * shopId/userId (or other) FK needs a line here, above `user`/`shop`.
 */
export async function resetDb() {
  // Deepest children first — bills' own line items/payments/credit
  // entries, purchase line items — before the rows they belong to.
  await prisma.billItem.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.purchaseItem.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.inventoryMovement.deleteMany();

  // Bill before cashierSession: Bill.sessionId references CashierSession.
  await prisma.bill.deleteMany();
  await prisma.billCounter.deleteMany();
  await prisma.cashierSession.deleteMany();

  await prisma.notification.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.product.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.shopSettings.deleteMany();

  // Auth/access rows.
  await prisma.session.deleteMany();
  await prisma.adminShopLink.deleteMany();
  await prisma.invitationCode.deleteMany();
  await prisma.auditLog.deleteMany();

  // User before shop: User.shopId references Shop.
  await prisma.user.deleteMany();
  await prisma.shop.deleteMany();
}
