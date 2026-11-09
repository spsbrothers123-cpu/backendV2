-- Phase 2 Stage 2.3 — ROLLBACK OF THE CUTOVER (writes!).
-- Only possible while NO stock has moved since the cutover. Needs explicit
-- authorization like the cutover itself.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 03b_inventory_cutover_rollback.sql
--
-- Why the restriction: after cutover, sales/purchases/adjustments write ONLY
-- to branch_inventories, while cashier_inventories is frozen. Flipping back
-- after stock has moved would resurrect stale Cashier numbers. In that case
-- this script ABORTS and the recovery path is the verified backup (or a
-- reviewed, owner-approved reconciliation) — never a silent copy-back.
BEGIN;
-- Lock ORDER matters (avoids a deadlock with an in-flight sale): first the flag
-- row, which waits for in-flight stock transactions and blocks new ones; only
-- then the tables, which by now nobody in the application is touching.
SELECT "value" FROM "system_flags" WHERE "key" = 'inventory_source' FOR UPDATE;

LOCK TABLE "cashier_inventories", "branch_inventories", "products" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    cur_mode text;
    cutover_at timestamp;
    n_moves bigint;
    n_diff bigint;
BEGIN
    SELECT "value", "updatedAt" INTO cur_mode, cutover_at FROM "system_flags" WHERE "key" = 'inventory_source' FOR UPDATE;
    IF cur_mode IS DISTINCT FROM 'BRANCH' THEN
        RAISE EXCEPTION 'Rollback refused: inventory_source is %, not BRANCH.', cur_mode;
    END IF;

    SELECT count(*) INTO n_moves FROM "inventory_movements" WHERE "createdAt" > cutover_at;
    IF n_moves > 0 THEN
        RAISE EXCEPTION 'Rollback refused: % stock movement(s) were recorded after the cutover (%). Restore from the verified backup or run an owner-approved reconciliation instead.', n_moves, cutover_at;
    END IF;

    SELECT count(*) INTO n_diff FROM (
        SELECT COALESCE(b."shopId", c."shopId")
        FROM "branch_inventories" b
        FULL JOIN (SELECT "shopId", "productId", sum("quantity") AS qty FROM "cashier_inventories" GROUP BY 1, 2) c
               ON c."shopId" = b."shopId" AND c."productId" = b."productId"
        WHERE COALESCE(b."quantity", 0) <> COALESCE(c.qty, 0)
    ) x;
    IF n_diff > 0 THEN
        RAISE EXCEPTION 'Rollback refused: % (shop, product) quantities differ between branch_inventories and cashier_inventories.', n_diff;
    END IF;

    DELETE FROM "branch_inventories";   -- derived copy only; the Cashier rows were never touched
    UPDATE "system_flags" SET "value" = 'CASHIER', "updatedAt" = clock_timestamp() WHERE "key" = 'inventory_source';
    RAISE NOTICE 'Rolled back: inventory_source = CASHIER, branch_inventories emptied.';
END $$;
COMMIT;
