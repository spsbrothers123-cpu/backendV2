-- RBR Egg Mart V2 — Phase 2, Stage 2.7 (2/2): bill cancellation record.
-- ADDITIVE ONLY: 4 nullable/defaulted columns, 1 index, 1 NOT VALID check.
-- No existing row is read, changed or deleted; no stock or balance is touched.
-- Idempotent (safe to re-run).

ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "cancelledById" TEXT;
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "cancelReason" TEXT;
ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "cancelledAfterSessionClose" BOOLEAN NOT NULL DEFAULT false;
-- (bills."cancelledAt" already exists from the original billing migration.)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bills_cancelledById_fkey') THEN
    ALTER TABLE "bills"
      ADD CONSTRAINT "bills_cancelledById_fkey"
      FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  -- Every NEW cancellation must carry actor, timestamp and a non-blank reason.
  -- NOT VALID: pre-existing rows (if any were ever CANCELLED) are not scanned
  -- or rejected; the rule applies to rows written/updated from now on.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bills_cancellation_complete_chk') THEN
    ALTER TABLE "bills"
      ADD CONSTRAINT "bills_cancellation_complete_chk"
      CHECK (
        "status" <> 'CANCELLED'
        OR ("cancelledAt" IS NOT NULL
            AND "cancelledById" IS NOT NULL
            AND "cancelReason" IS NOT NULL
            AND length(btrim("cancelReason")) > 0)
      ) NOT VALID;
  END IF;
END $$;

-- Credit reversal is idempotent at the database level: a bill can have at
-- most ONE reversal row, so even a bug or a race can never reverse twice.
CREATE UNIQUE INDEX IF NOT EXISTS "credit_transactions_one_reversal_per_bill"
  ON "credit_transactions" ("billId")
  WHERE "type" = 'REVERSAL';
