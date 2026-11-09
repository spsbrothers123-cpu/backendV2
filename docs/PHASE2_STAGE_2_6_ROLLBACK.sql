-- Stage 2.6 rollback. Refuses if any reversal exists (those carry real stock
-- movements — use the verified-backup procedure instead).
DO $$ BEGIN
  IF to_regclass('purchase_reversals') IS NOT NULL AND EXISTS (SELECT 1 FROM "purchase_reversals") THEN
    RAISE EXCEPTION 'purchase_reversals has rows; do not drop. Restore from verified backup instead.';
  END IF;
END $$;
DROP TRIGGER IF EXISTS purchases_receiving_branch_immutable_trg ON "purchases";
DROP FUNCTION IF EXISTS purchases_receiving_branch_immutable();
DROP TABLE IF EXISTS "purchase_reversals";
-- (The 'PURCHASE_REVERSED' enum value cannot be dropped in Postgres; it is harmless.)
