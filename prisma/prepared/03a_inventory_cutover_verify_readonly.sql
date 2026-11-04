-- Phase 2 Stage 2.3 — PRE-CUTOVER VERIFICATION (READ ONLY).
-- Run on a restored copy first (rehearsal), and again on production
-- IMMEDIATELY BEFORE the freeze only when separately authorized. It cannot
-- change anything: the whole script is a READ ONLY transaction.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 03a_inventory_cutover_verify_readonly.sql
--
-- It answers: if BranchInventory were backfilled now (quantity = SUM of the
-- branch's CashierInventory), would every invariant hold? The cutover script
-- (03_inventory_cutover.sql) re-checks all of this and ABORTS on any failure.
BEGIN READ ONLY;

-- 1. Current mode (must be CASHIER before cutover).
SELECT "key", "value", "updatedAt" FROM "system_flags" WHERE "key" = 'inventory_source';

-- 2. Hard-stop A: Product.stock vs SUM(CashierInventory) per product.
--    Any row here is a stock discrepancy. Empty = no drift.
SELECT p."id" AS product_id, p."name", p."shopId" AS origin_shop,
       p."stock" AS product_stock, COALESCE(c.qty, 0) AS cashier_inventory_sum,
       p."stock" - COALESCE(c.qty, 0) AS difference
FROM "products" p
LEFT JOIN (SELECT "productId", sum("quantity") AS qty FROM "cashier_inventories" GROUP BY 1) c
       ON c."productId" = p."id"
WHERE p."stock" <> COALESCE(c.qty, 0)
ORDER BY abs(p."stock" - COALESCE(c.qty, 0)) DESC, p."name";

-- 3. Hard-stop B: negative quantities anywhere.
SELECT 'cashier_inventories' AS source, "id", "shopId", "productId", "quantity" FROM "cashier_inventories" WHERE "quantity" < 0
UNION ALL
SELECT 'products', "id", "shopId", "id", "stock" FROM "products" WHERE "stock" < 0;

-- 4. Hard-stop C: branch_inventories must be empty before cutover.
SELECT count(*) AS branch_inventory_rows_must_be_zero FROM "branch_inventories";

-- 5. Information: stock that sits at a branch where the product is NOT
--    assigned (it will be preserved, just hidden) or has no branch_products row.
SELECT c."shopId", s."code", c."productId", p."name", sum(c."quantity") AS qty,
       COALESCE(bp."isAssigned"::text, 'NO ROW') AS assignment
FROM "cashier_inventories" c
JOIN "shops" s ON s."id" = c."shopId"
JOIN "products" p ON p."id" = c."productId"
LEFT JOIN "branch_products" bp ON bp."shopId" = c."shopId" AND bp."productId" = c."productId"
GROUP BY c."shopId", s."code", c."productId", p."name", bp."isAssigned"
HAVING sum(c."quantity") <> 0 AND COALESCE(bp."isAssigned", false) = false;

-- 6. Preview: what BranchInventory would contain, per branch.
SELECT s."code" AS shop_code, count(*) AS rows, sum(k.qty) AS total_quantity
FROM (
  SELECT "shopId", "productId", sum("quantity") AS qty FROM "cashier_inventories" GROUP BY 1, 2
) k JOIN "shops" s ON s."id" = k."shopId"
GROUP BY s."code" ORDER BY s."code";

-- 7. VERDICT.
SELECT CASE
  WHEN (SELECT "value" FROM "system_flags" WHERE "key" = 'inventory_source') IS DISTINCT FROM 'CASHIER' THEN 'BLOCKED: not in CASHIER mode'
  WHEN EXISTS (SELECT 1 FROM "branch_inventories") THEN 'BLOCKED: branch_inventories not empty'
  WHEN EXISTS (SELECT 1 FROM "cashier_inventories" WHERE "quantity" < 0) OR EXISTS (SELECT 1 FROM "products" WHERE "stock" < 0) THEN 'BLOCKED: negative quantities'
  WHEN EXISTS (
    SELECT 1 FROM "products" p
    LEFT JOIN (SELECT "productId", sum("quantity") AS qty FROM "cashier_inventories" GROUP BY 1) c ON c."productId" = p."id"
    WHERE p."stock" <> COALESCE(c.qty, 0)
  ) THEN 'BLOCKED: Product.stock does not match SUM(CashierInventory) — HARD STOP, do not correct silently'
  ELSE 'READY: all invariants hold'
END AS verdict;

ROLLBACK;
