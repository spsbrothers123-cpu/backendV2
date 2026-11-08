-- Phase 2 Stage 2.1 ROLLBACK. Reverses migration
-- 20261026000000_phase2_branch_product_inventory and nothing else.
--
-- SAFE ONLY WHILE the two tables are unused (Stage 2.1 state). Once Stage 2.2/2.3
-- code has written to them, do NOT run this blindly: it would discard branch
-- assignments / branch stock. After 2.3 cutover, rollback is a separate,
-- rehearsed procedure (restore from verified backup), not this script.
--
-- Guard: refuses to drop a table that already contains rows.
BEGIN;
DO $$
DECLARE n_bp bigint := 0; n_bi bigint := 0;
BEGIN
    IF to_regclass('public.branch_products') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM branch_products' INTO n_bp;
    END IF;
    IF to_regclass('public.branch_inventories') IS NOT NULL THEN
        EXECUTE 'SELECT count(*) FROM branch_inventories' INTO n_bi;
    END IF;
    IF n_bp > 0 OR n_bi > 0 THEN
        RAISE EXCEPTION 'Rollback refused: branch_products=% rows, branch_inventories=% rows. Data exists; use the backup-restore procedure instead.', n_bp, n_bi;
    END IF;
END $$;
DROP TABLE IF EXISTS "branch_inventories";
DROP TABLE IF EXISTS "branch_products";
-- If the migration was recorded by Prisma, also mark it rolled back:
--   npx prisma migrate resolve --rolled-back 20261026000000_phase2_branch_product_inventory
-- (and delete the migration folder + the two models from schema.prisma in the same revert commit).
COMMIT;
