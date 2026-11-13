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
 * Wrapped in a single $transaction so the whole reset is atomic — no
 * other connection can observe (or insert into) a half-wiped DB between
 * individual deleteMany() calls. Integration tests must also run
 * serially (see vitest.config.ts: fileParallelism: false, pool: "forks",
 * singleFork: true) since they share one real Postgres database; this
 * transaction is defense-in-depth on top of that, not a substitute for it.
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
  await prisma.$transaction([
    // Deepest children first — bills' own line items/payments/credit
    // entries, purchase line items — before the rows they belong to.
    prisma.billItem.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.creditTransaction.deleteMany(),
    prisma.purchaseItem.deleteMany(),
    // PurchaseReversal.purchaseId -> Purchase has no onDelete, so it must
    // go before purchase.
    prisma.purchaseReversal.deleteMany(),
    prisma.purchase.deleteMany(),
    prisma.inventoryMovement.deleteMany(),

    // Bill before cashierSession: Bill.sessionId references CashierSession.
    prisma.bill.deleteMany(),
    prisma.billCounter.deleteMany(),
    prisma.cashierSession.deleteMany(),

    prisma.notification.deleteMany(),
    // Phase 3 notification engine (all new tables; recipients cascade from notifications/users)
    prisma.appNotificationRecipient.deleteMany(),
    prisma.appNotification.deleteMany(),
    prisma.announcement.deleteMany(),
    prisma.notificationPreference.deleteMany(),
    prisma.branchProductLowStock.deleteMany(),
    prisma.branchNotificationSettings.deleteMany(),
    prisma.notificationStockState.deleteMany(),
    prisma.notificationJobState.deleteMany(),
    prisma.dailySummary.deleteMany(),
    prisma.expense.deleteMany(),

    // CashierInventory has FKs to product, cashier (User), and shop —
    // must go before all three of their deleteMany() calls.
    prisma.cashierInventory.deleteMany(),

    // Phase 2 branch tables: FKs to product and shop, no onDelete (RESTRICT),
    // so they must go before product and shop.
    prisma.branchInventory.deleteMany(),
    prisma.branchProduct.deleteMany(),

    prisma.product.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.shopSettings.deleteMany(),

    // Auth/access rows.
    prisma.session.deleteMany(),
    prisma.adminShopLink.deleteMany(),
    prisma.invitationCode.deleteMany(),
    prisma.auditLog.deleteMany(),
    // Admin recovery (FKs to user; cleared before it).
    // Cashier admin-assisted recovery requests (FK to user).
    prisma.cashierRecoveryRequest.deleteMany(),
    prisma.adminRecoveryGrant.deleteMany(),
    prisma.adminRecoveryCode.deleteMany(),
    prisma.adminRecoveryAudit.deleteMany(),
    prisma.adminPasskeyChallenge.deleteMany(),
    prisma.adminRecoveryChallenge.deleteMany(),
    prisma.adminPasskey.deleteMany(),
    // UPI Management config (FKs to user/shop; cleared before both).
    prisma.upiShopAccount.deleteMany(),
    prisma.upiCommonAccount.deleteMany(),

    // User before shop: User.shopId references Shop.
    prisma.user.deleteMany(),
    prisma.shop.deleteMany(),
  ]);
}
