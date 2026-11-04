-- RBR Egg Mart V2 — Phase 2, Stage 2.1: schema preparation (ADDITIVE ONLY).
--
-- Adds two EMPTY tables:
--   * branch_products    — per-branch product assignment + optional price
--                          override (isAssigned, priceOverride, metadata).
--   * branch_inventories — per-branch stock; becomes the authoritative stock
--                          source only after the Stage 2.3 authorized cutover.
--
-- What this migration does NOT do (by design):
--   * No data is read, copied, backfilled, moved or changed. Both tables are
--     created empty. Backfills belong to Stage 2.2 (assignments) and
--     Stage 2.3 (stock, with verification and a hard stop on any mismatch).
--   * No existing table, column, index, constraint or row is altered, dropped
--     or reset. products (IDs, shopId, stock), cashier_inventories,
--     inventory_movements, bills, purchases, customers and credits are
--     untouched.
--   * No global barcode uniqueness and no one-cashier-per-branch constraint.
--     Both are prepared separately in prisma/prepared/ and are applied only
--     after the Q1 data checks pass and you approve (see
--     docs/PHASE2_STAGE_2_1_MIGRATION_PLAN.md).
--
-- Rollback: docs/PHASE2_STAGE_2_1_ROLLBACK.sql (drops only these two tables;
-- safe while they are still unused/empty).
--
-- NOTE: hand-authored in the same style as the earlier migrations in this
-- repo. Before applying anywhere, run
--   npx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma --script
-- and confirm there is no difference other than the CHECK constraints below
-- (Prisma cannot express CHECK constraints and ignores them).
--
-- Idempotent: every statement is guarded so a re-run is a no-op.

-- ── CreateTable: branch_products ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "branch_products" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "isAssigned" BOOLEAN NOT NULL DEFAULT true,
    "priceOverride" DECIMAL(12,2),
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedById" TEXT,
    "unassignedAt" TIMESTAMP(3),
    "unassignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "branch_products_priceOverride_nonneg_chk"
        CHECK ("priceOverride" IS NULL OR "priceOverride" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "branch_products_shopId_productId_key"
    ON "branch_products"("shopId", "productId");
CREATE INDEX IF NOT EXISTS "branch_products_shopId_isAssigned_idx"
    ON "branch_products"("shopId", "isAssigned");
CREATE INDEX IF NOT EXISTS "branch_products_productId_idx"
    ON "branch_products"("productId");

-- ── CreateTable: branch_inventories ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "branch_inventories" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_inventories_pkey" PRIMARY KEY ("id"),
    -- Branch stock can never be negative (defence in depth for the atomic
    -- conditional updates added in Stage 2.3).
    CONSTRAINT "branch_inventories_quantity_nonneg_chk" CHECK ("quantity" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "branch_inventories_shopId_productId_key"
    ON "branch_inventories"("shopId", "productId");
CREATE INDEX IF NOT EXISTS "branch_inventories_productId_idx"
    ON "branch_inventories"("productId");

-- ── Foreign keys (RESTRICT: a branch/product with branch rows cannot be
--    deleted out from under them; matches the existing schema's behaviour) ─
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_products_shopId_fkey') THEN
        ALTER TABLE "branch_products"
            ADD CONSTRAINT "branch_products_shopId_fkey"
            FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_products_productId_fkey') THEN
        ALTER TABLE "branch_products"
            ADD CONSTRAINT "branch_products_productId_fkey"
            FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_inventories_shopId_fkey') THEN
        ALTER TABLE "branch_inventories"
            ADD CONSTRAINT "branch_inventories_shopId_fkey"
            FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branch_inventories_productId_fkey') THEN
        ALTER TABLE "branch_inventories"
            ADD CONSTRAINT "branch_inventories_productId_fkey"
            FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
