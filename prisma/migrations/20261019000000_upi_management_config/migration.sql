-- UPI Management (Admin configuration — Phase 3 of the UPI QR feature).
--
-- Purely additive and independent of existing data: creates one enum, two
-- NEW empty tables and one AuditAction value. It does not read, backfill,
-- alter or delete any existing row, column, index or constraint, and it
-- adds no unique constraint to any table that already holds data — so it
-- cannot fail or change behaviour because of anything in production data
-- (legacy payments.reference values are not touched or inspected).

-- ── AuditAction ─────────────────────────────────────────────────────────
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'UPI_CONFIG_UPDATED';

-- ── CreateEnum ──────────────────────────────────────────────────────────
CREATE TYPE "UpiAccountMode" AS ENUM ('COMMON', 'CUSTOM');

-- ── CreateTable: upi_common_accounts ────────────────────────────────────
CREATE TABLE "upi_common_accounts" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "upiId" TEXT NOT NULL,
    "payeeName" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upi_common_accounts_pkey" PRIMARY KEY ("id")
);

-- ── CreateTable: upi_shop_accounts ──────────────────────────────────────
CREATE TABLE "upi_shop_accounts" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "mode" "UpiAccountMode" NOT NULL DEFAULT 'COMMON',
    "customUpiId" TEXT,
    "customPayeeName" TEXT,
    "customEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upi_shop_accounts_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "upi_common_accounts_adminId_key" ON "upi_common_accounts"("adminId");
CREATE UNIQUE INDEX "upi_shop_accounts_adminId_shopId_key" ON "upi_shop_accounts"("adminId", "shopId");
CREATE INDEX "upi_shop_accounts_shopId_idx" ON "upi_shop_accounts"("shopId");

-- ── AddForeignKey ───────────────────────────────────────────────────────
ALTER TABLE "upi_common_accounts" ADD CONSTRAINT "upi_common_accounts_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upi_shop_accounts" ADD CONSTRAINT "upi_shop_accounts_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "upi_shop_accounts" ADD CONSTRAINT "upi_shop_accounts_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
