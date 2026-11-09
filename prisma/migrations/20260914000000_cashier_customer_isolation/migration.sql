-- Phase 3: cashier-level customer isolation.
-- Adds Customer.cashierId (nullable — null means "admin-created /
-- unassigned", not "not yet migrated") and replaces the shop-wide
-- (shopId, phone) uniqueness with (shopId, cashierId, phone) so two
-- cashiers in the same shop can each have their own customer record
-- for the same phone number without colliding.
--
-- NOTE: this migration was authored by hand (not via `prisma migrate dev`)
-- because this environment's network egress does not allow downloading
-- Prisma's schema-engine binary — same constraint noted in
-- 20260906000000_multi_shop_foundation. Before applying against a real
-- database, run `npx prisma migrate diff --from-migrations
-- prisma/migrations --to-schema-datamodel prisma/schema.prisma --script`
-- (with network access) to confirm this SQL matches what Prisma itself
-- would generate, then `npx prisma migrate dev` to record it normally.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "cashierId" TEXT;

-- DropIndex (old shop-wide uniqueness)
DROP INDEX IF EXISTS "customers_shopId_phone_key";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "customers_shopId_cashierId_idx" ON "customers"("shopId", "cashierId");

-- CreateIndex (new per-cashier uniqueness)
CREATE UNIQUE INDEX IF NOT EXISTS "customers_shopId_cashierId_phone_key" ON "customers"("shopId", "cashierId", "phone");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "customers" ADD CONSTRAINT "customers_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
