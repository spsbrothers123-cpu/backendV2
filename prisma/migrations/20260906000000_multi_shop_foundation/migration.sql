-- Multi-shop foundation (RBR Egg Mart Phase 1).
--
-- Adds: (1) a `location` column on `shops` — the raw branch/area name a
-- shop is identified and named from at signup (distinct from the existing
-- free-text `address` field used on the Admin Settings page); (2) new
-- AuditAction values for admin signup / shop creation / shop linking /
-- shop switching; (3) `admin_shop_links`, a join table letting one Admin
-- own several shops.
--
-- Purely additive — no existing table is dropped, no existing column is
-- altered destructively, and no existing row is modified. Existing admins
-- are not backfilled into `admin_shop_links` here; the application lazily
-- self-heals each admin's link the first time their shop access is
-- checked (see src/lib/shopAccess.ts), so this migration never needs to
-- guess at UUID generation in raw SQL.
--
-- NOTE: this migration was authored by hand (not via `prisma migrate dev`)
-- because this environment's network egress does not allow downloading
-- Prisma's schema-engine binary. Before applying against a real database,
-- run `npx prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --script` (with network
-- access) to confirm this SQL matches what Prisma itself would generate,
-- then `npx prisma migrate dev` to record it normally.

-- ── shops: raw location ──────────────────────────────────────────────────
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "location" TEXT;

-- ── AuditAction: new values only ─────────────────────────────────────────
-- Unlike the AccountStatus/AuditAction rework in
-- 20260831000000_invitation_code_signup (which had to rename+recreate the
-- type because it REMOVED a value), this only ADDS values, which Postgres
-- 9.6+ supports in place. None of these values are referenced anywhere
-- else in this same migration file, so the "can't use a new enum value in
-- the transaction that added it" restriction doesn't apply here.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ADMIN_SIGNUP';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SHOP_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SHOP_LINKED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'SHOP_SWITCHED';

-- ── CreateTable: admin_shop_links ─────────────────────────────────────────
CREATE TABLE "admin_shop_links" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_shop_links_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ──────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "admin_shop_links_adminId_shopId_key" ON "admin_shop_links"("adminId", "shopId");
CREATE INDEX "admin_shop_links_shopId_idx" ON "admin_shop_links"("shopId");

-- ── AddForeignKey ────────────────────────────────────────────────────────
ALTER TABLE "admin_shop_links" ADD CONSTRAINT "admin_shop_links_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_shop_links" ADD CONSTRAINT "admin_shop_links_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
