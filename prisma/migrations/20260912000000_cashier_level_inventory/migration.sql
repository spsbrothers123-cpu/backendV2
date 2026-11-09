-- Cashier-level inventory foundation (RBR Egg Mart Phase 1 addition).
--
-- Problem: `products.stock` was a single shop-wide number. Multiple
-- cashiers at the same shop were implicitly sharing one pool of stock,
-- which is exactly the "Shop -> one shared inventory" architecture this
-- migration replaces with "Shop -> multiple cashiers -> independent
-- inventories".
--
-- What this does:
--   1. Creates `cashier_inventories` (shopId, cashierId, productId,
--      quantity) — the new source of truth for how much stock a specific
--      cashier has of a specific product. One row per (shop, cashier,
--      product) triple; never merged across cashiers.
--   2. Adds a nullable `cashierId` column to `inventory_movements` so every
--      future stock movement records whose inventory it changed (distinct
--      from `actorId`, who performed the action — an admin can act on a
--      cashier's behalf). Historical rows keep `cashierId = NULL`; nothing
--      is guessed or backfilled for them.
--   3. Backfills `cashier_inventories` from existing `products.stock`:
--      for each shop, the EARLIEST-created ACTIVE cashier on that shop is
--      designated the owner of that shop's entire existing stock (per
--      product). This was an explicit product decision (not inferred) —
--      existing stock had no per-cashier breakdown to preserve, and this
--      is the safest deterministic mapping that keeps all the numbers
--      intact somewhere rather than splitting or discarding them.
--   4. `products.stock` itself is NOT changed by the backfill — it already
--      equals the sum being assigned to the single designated cashier, and
--      going forward it is maintained as a denormalized SUM of every
--      cashier's quantity for that product (see src/services/
--      inventoryService.ts). Shops with no ACTIVE cashier yet are left
--      with `products.stock` unchanged and no cashier_inventories rows —
--      no data is lost, there's simply nobody to own it yet until a
--      cashier exists there.
--
-- Purely additive: no existing table is dropped, no existing column is
-- altered destructively, and no existing row's data is deleted.
--
-- NOTE: hand-authored (see the same note in
-- 20260906000000_multi_shop_foundation/migration.sql) because this
-- environment's network egress does not allow downloading Prisma's
-- schema-engine binary. Before applying against a real database, run
-- `npx prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --script` to confirm this SQL
-- matches what Prisma itself would generate, then `npx prisma migrate dev`
-- to record it normally.

-- ── CreateTable: cashier_inventories ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "cashier_inventories" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cashier_inventories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cashier_inventories_shopId_cashierId_productId_key"
    ON "cashier_inventories"("shopId", "cashierId", "productId");
CREATE INDEX IF NOT EXISTS "cashier_inventories_shopId_cashierId_idx"
    ON "cashier_inventories"("shopId", "cashierId");
CREATE INDEX IF NOT EXISTS "cashier_inventories_productId_idx"
    ON "cashier_inventories"("productId");

ALTER TABLE "cashier_inventories"
    ADD CONSTRAINT "cashier_inventories_shopId_fkey"
    FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cashier_inventories"
    ADD CONSTRAINT "cashier_inventories_cashierId_fkey"
    FOREIGN KEY ("cashierId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cashier_inventories"
    ADD CONSTRAINT "cashier_inventories_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── AlterTable: inventory_movements gets a cashier owner column ──────────
ALTER TABLE "inventory_movements" ADD COLUMN IF NOT EXISTS "cashierId" TEXT;
CREATE INDEX IF NOT EXISTS "inventory_movements_cashierId_idx" ON "inventory_movements"("cashierId");
ALTER TABLE "inventory_movements"
    ADD CONSTRAINT "inventory_movements_cashierId_fkey"
    FOREIGN KEY ("cashierId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Data backfill: designate one existing cashier per shop as the owner
--    of that shop's existing (pre-migration) stock ───────────────────────
--
-- "Earliest-created ACTIVE cashier per shop" — deterministic, no
-- guesswork, and picks a real cashier over an arbitrary placeholder.
WITH designated_cashier AS (
    SELECT DISTINCT ON ("shopId") "id" AS "cashierId", "shopId"
    FROM "users"
    WHERE "role" = 'CASHIER' AND "status" = 'ACTIVE' AND "shopId" IS NOT NULL
    ORDER BY "shopId", "createdAt" ASC
)
INSERT INTO "cashier_inventories" ("id", "shopId", "cashierId", "productId", "quantity", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    p."shopId",
    dc."cashierId",
    p."id",
    p."stock",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "products" p
JOIN designated_cashier dc ON dc."shopId" = p."shopId"
ON CONFLICT ("shopId", "cashierId", "productId") DO NOTHING;

-- NOTE: requires the pgcrypto extension for gen_random_uuid() (already
-- relied on implicitly by Postgres 13+/Supabase, which enable it by
-- default). If gen_random_uuid() is unavailable, run
-- `CREATE EXTENSION IF NOT EXISTS pgcrypto;` first.
