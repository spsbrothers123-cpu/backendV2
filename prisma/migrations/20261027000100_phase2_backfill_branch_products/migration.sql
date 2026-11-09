-- RBR Egg Mart V2 — Phase 2, Stage 2.2: backfill branch_products.
--
-- Gives every EXISTING product an assigned row at its ORIGIN shop
-- (products.shopId) — exactly the visibility it has today, so nothing
-- appears or disappears for any Cashier or Admin when the new code ships.
--
-- Deliberately NOT done here:
--   * No product is assigned to any OTHER existing shop. Products that exist
--     as separate per-shop rows are never merged or cross-assigned
--     automatically; that needs the approved Q4 manual decision.
--     (New products created after this stage are assigned to every branch by
--     the application; new branches get every product.)
--   * No stock is read, created or changed. branch_inventories stays empty
--     (Stage 2.3). products.stock, cashier_inventories and
--     inventory_movements are untouched.
--   * Inactive products are included (assignment is independent of
--     products.status).
--
-- Additive + idempotent (ON CONFLICT DO NOTHING; safe to re-run).
-- Self-checking: the migration aborts and rolls back if any product ends up
-- without a row at its origin shop.

INSERT INTO "branch_products"
    ("id", "shopId", "productId", "isAssigned", "assignedAt", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, p."shopId", p."id", true, now(), now(), now()
FROM "products" p
ON CONFLICT ("shopId", "productId") DO NOTHING;

DO $$
DECLARE missing bigint;
BEGIN
    SELECT count(*) INTO missing
    FROM "products" p
    WHERE NOT EXISTS (
        SELECT 1 FROM "branch_products" b
        WHERE b."shopId" = p."shopId" AND b."productId" = p."id"
    );
    IF missing > 0 THEN
        RAISE EXCEPTION 'branch_products backfill incomplete: % product(s) have no row at their origin shop.', missing;
    END IF;
END $$;
