-- Phase 2 Stage 2.7 rollback (run ONLY if no bill has been cancelled yet, or
-- after you have exported the cancellation data you want to keep).
-- Enum values (AuditAction.BILL_CANCELLED, CreditTxnType.REVERSAL) cannot be
-- removed from a Postgres enum; they are harmless when unused and are left.
BEGIN;
DROP INDEX IF EXISTS "credit_transactions_one_reversal_per_bill";
ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS "bills_cancellation_complete_chk";
ALTER TABLE "bills" DROP CONSTRAINT IF EXISTS "bills_cancelledById_fkey";
-- Dropping these columns discards cancellation reasons/actors. Cancelled
-- bills would keep status CANCELLED but lose that metadata — so only do this
-- when zero cancellations exist:
--   SELECT count(*) FROM bills WHERE status = 'CANCELLED';   -- must be 0
ALTER TABLE "bills" DROP COLUMN IF EXISTS "cancelledAfterSessionClose";
ALTER TABLE "bills" DROP COLUMN IF EXISTS "cancelReason";
ALTER TABLE "bills" DROP COLUMN IF EXISTS "cancelledById";
COMMIT;
