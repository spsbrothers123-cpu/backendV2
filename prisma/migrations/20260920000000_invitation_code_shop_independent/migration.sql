-- RBR Egg Mart V2 — Phase 1: make invitation codes shop-independent.
--
-- Previously every invitation code carried a mandatory shopId, so
-- generating a code always stamped it with whichever shop the Admin app's
-- Global Shop Selector happened to have active (in practice, almost always
-- the seeded "Egg Mart - Main Branch"). A code is now purely an
-- authorization to register as a cashier; which shop the cashier joins is
-- decided at signup time from their own Branch Name (see
-- src/lib/shopAccess.ts resolveOrCreateShopByLocation and
-- src/routes/auth.ts POST /signup).
--
-- shopId is kept as a nullable column, not dropped: existing invitation
-- codes retain their original (possibly incorrect) shop for audit/history
-- purposes, but no code path reads or writes it for newly generated codes.
--
-- NOTE: this migration was authored by hand (not via `prisma migrate dev`)
-- because this environment's network egress does not allow downloading
-- Prisma's schema-engine binary. Before applying against a real database,
-- run `npx prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --script` (with network
-- access) to confirm this SQL matches what Prisma itself would generate,
-- then `npx prisma migrate dev` to record it normally.

ALTER TABLE "invitation_codes" DROP CONSTRAINT "invitation_codes_shopId_fkey";
ALTER TABLE "invitation_codes" ALTER COLUMN "shopId" DROP NOT NULL;
ALTER TABLE "invitation_codes" ADD CONSTRAINT "invitation_codes_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
