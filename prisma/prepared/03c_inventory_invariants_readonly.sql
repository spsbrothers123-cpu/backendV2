-- Phase 2 Stage 2.3 — POST-CUTOVER INVARIANT CHECK (READ ONLY). Safe to run any time.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 03c_inventory_invariants_readonly.sql
-- Every result set should be EMPTY (the last row says OK or lists problems).
BEGIN READ ONLY;

-- Product.stock must equal the SUM across branches.
SELECT p."id", p."name", p."stock" AS product_stock, COALESCE(b.qty, 0) AS branch_sum
FROM "products" p
LEFT JOIN (SELECT "productId", sum("quantity") AS qty FROM "branch_inventories" GROUP BY 1) b ON b."productId" = p."id"
WHERE p."stock" <> COALESCE(b.qty, 0);

-- No negative branch stock.
SELECT * FROM "branch_inventories" WHERE "quantity" < 0;

-- After cutover, cashier_inventories must not have changed: no row touched after the cutover time.
SELECT c."id", c."shopId", c."cashierId", c."productId", c."updatedAt"
FROM "cashier_inventories" c
JOIN "system_flags" f ON f."key" = 'inventory_source' AND f."value" = 'BRANCH'
WHERE c."updatedAt" > f."updatedAt";

SELECT "value" AS inventory_source, "updatedAt" AS since FROM "system_flags" WHERE "key" = 'inventory_source';
ROLLBACK;
