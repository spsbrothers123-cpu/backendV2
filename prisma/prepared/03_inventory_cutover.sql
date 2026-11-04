-- Phase 2 Stage 2.3 — BRANCH INVENTORY CUTOVER (writes!).
--
-- *** DO NOT RUN WITHOUT SEPARATE, EXPLICIT WRITTEN AUTHORIZATION. ***
-- Required beforehand (docs/PHASE2_STAGE_2_3_CUTOVER_RUNBOOK.md):
--   1. verified backup,  2. rehearsal on a restored copy,  3. approved billing
--   freeze,  4. 03a verification = READY,  5. new code deployed (it behaves
--   identically in CASHIER mode, so deploying it early is safe).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 03_inventory_cutover.sql
--
-- ONE transaction. Any failed invariant RAISES, which aborts and rolls back
-- EVERYTHING (no rows, no flag change). Nothing is ever "fixed up": a
-- discrepancy is a HARD STOP for the owner to resolve.
--
-- What it does:
--   * Freeze: takes the system_flags row FOR UPDATE. Every stock-changing
--     transaction holds that row FOR SHARE, so this waits for in-flight ones
--     and blocks new ones until COMMIT (a DB-level freeze, in addition to the
--     operational one). Also write-locks the stock tables against any
--     non-application writer.
--   * Backfill: branch_inventories.quantity = SUM(cashier_inventories.quantity)
--     per (shop, product), for every assigned branch product (0 if none) plus
--     every (shop, product) that holds stock.
--   * Verifies: per-row equality with the Cashier sums, Product.stock = the
--     per-product SUM across branches, grand totals, no negatives.
--   * Flips inventory_source to BRANCH. cashier_inventories, products,
--     inventory_movements, bills etc. are NOT modified.
BEGIN;

-- Lock ORDER matters (avoids a deadlock with an in-flight sale): first the flag
-- row, which waits for in-flight stock transactions and blocks new ones; only
-- then the tables, which by now nobody in the application is touching.
SELECT "value" FROM "system_flags" WHERE "key" = 'inventory_source' FOR UPDATE;

LOCK TABLE "cashier_inventories", "branch_inventories", "products" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    cur_mode      text;
    n_negative    bigint;
    n_rows        bigint;
    n_row_mismatch bigint;
    n_prod_mismatch bigint;
    detail        text;
    sum_ci        bigint;
    sum_bi        bigint;
    sum_prod      bigint;
BEGIN
    -- Freeze + mode check
    SELECT "value" INTO cur_mode FROM "system_flags" WHERE "key" = 'inventory_source' FOR UPDATE;
    IF cur_mode IS NULL THEN
        RAISE EXCEPTION 'HARD STOP: system_flags row inventory_source is missing — apply migration 20261028000000_phase2_system_flags first.';
    END IF;
    IF cur_mode <> 'CASHIER' THEN
        RAISE EXCEPTION 'HARD STOP: inventory_source is already % — cutover was already performed.', cur_mode;
    END IF;

    -- Preconditions
    IF EXISTS (SELECT 1 FROM "branch_inventories") THEN
        RAISE EXCEPTION 'HARD STOP: branch_inventories is not empty. Refusing to overwrite or merge.';
    END IF;
    SELECT (SELECT count(*) FROM "cashier_inventories" WHERE "quantity" < 0)
         + (SELECT count(*) FROM "products" WHERE "stock" < 0) INTO n_negative;
    IF n_negative > 0 THEN
        RAISE EXCEPTION 'HARD STOP: % negative stock value(s) exist in cashier_inventories/products.', n_negative;
    END IF;

    -- Pre-check Product.stock against the Cashier sums BEFORE writing anything
    SELECT count(*), string_agg(format('%s [%s]: products.stock=%s, cashier sum=%s', name, id, stock, qty), E'\n' ORDER BY abs(stock - qty) DESC)
      INTO n_prod_mismatch, detail
    FROM (
        SELECT p."id", p."name", p."stock", COALESCE(c.qty, 0) AS qty
        FROM "products" p
        LEFT JOIN (SELECT "productId", sum("quantity") AS qty FROM "cashier_inventories" GROUP BY 1) c ON c."productId" = p."id"
        WHERE p."stock" <> COALESCE(c.qty, 0)
        LIMIT 20
    ) d;
    IF n_prod_mismatch > 0 THEN
        RAISE EXCEPTION E'HARD STOP: Product.stock does not match SUM(CashierInventory) for % product(s) (first 20 shown). Nothing was changed.\n%', n_prod_mismatch, detail;
    END IF;

    -- Backfill
    INSERT INTO "branch_inventories" ("id", "shopId", "productId", "quantity", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, k."shopId", k."productId", COALESCE(c.qty, 0), clock_timestamp(), clock_timestamp()
    FROM (
        SELECT "shopId", "productId" FROM "branch_products"
        UNION
        SELECT "shopId", "productId" FROM "cashier_inventories"
    ) k
    LEFT JOIN (
        SELECT "shopId", "productId", sum("quantity")::integer AS qty
        FROM "cashier_inventories" GROUP BY 1, 2
    ) c ON c."shopId" = k."shopId" AND c."productId" = k."productId";
    GET DIAGNOSTICS n_rows = ROW_COUNT;

    -- Verify 1: every (shop, product) equals the sum of its Cashier rows
    SELECT count(*) INTO n_row_mismatch FROM (
        SELECT COALESCE(b."shopId", c."shopId") AS s, COALESCE(b."productId", c."productId") AS p
        FROM "branch_inventories" b
        FULL JOIN (SELECT "shopId", "productId", sum("quantity") AS qty FROM "cashier_inventories" GROUP BY 1, 2) c
               ON c."shopId" = b."shopId" AND c."productId" = b."productId"
        WHERE COALESCE(b."quantity", 0) <> COALESCE(c.qty, 0)
    ) x;
    IF n_row_mismatch > 0 THEN
        RAISE EXCEPTION 'HARD STOP: % (shop, product) row(s) differ from the Cashier sums after backfill. Rolled back.', n_row_mismatch;
    END IF;

    -- Verify 2: Product.stock = SUM(BranchInventory) for EVERY product
    SELECT count(*), string_agg(format('%s [%s]: products.stock=%s, branch sum=%s', name, id, stock, qty), E'\n')
      INTO n_prod_mismatch, detail
    FROM (
        SELECT p."id", p."name", p."stock", COALESCE(b.qty, 0) AS qty
        FROM "products" p
        LEFT JOIN (SELECT "productId", sum("quantity") AS qty FROM "branch_inventories" GROUP BY 1) b ON b."productId" = p."id"
        WHERE p."stock" <> COALESCE(b.qty, 0)
        LIMIT 20
    ) d;
    IF n_prod_mismatch > 0 THEN
        RAISE EXCEPTION E'HARD STOP: Product.stock does not equal SUM(BranchInventory) for % product(s). Rolled back.\n%', n_prod_mismatch, detail;
    END IF;

    -- Verify 3: grand totals
    SELECT COALESCE(sum("quantity"), 0) INTO sum_ci FROM "cashier_inventories";
    SELECT COALESCE(sum("quantity"), 0) INTO sum_bi FROM "branch_inventories";
    SELECT COALESCE(sum("stock"), 0) INTO sum_prod FROM "products";
    IF sum_ci <> sum_bi OR sum_bi <> sum_prod THEN
        RAISE EXCEPTION 'HARD STOP: grand totals differ (cashier=%, branch=%, product=%). Rolled back.', sum_ci, sum_bi, sum_prod;
    END IF;

    -- Switch over (same transaction as the backfill)
    UPDATE "system_flags" SET "value" = 'BRANCH', "updatedAt" = clock_timestamp() WHERE "key" = 'inventory_source';

    RAISE NOTICE 'Cutover OK: % branch_inventories rows, total quantity % (= Product.stock total). inventory_source = BRANCH.', n_rows, sum_bi;
END $$;

COMMIT;
