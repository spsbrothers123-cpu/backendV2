-- RBR Egg Mart V2 — Phase 2, Stage 2.6: purchase receiving branch + reversal.
-- ADDITIVE ONLY: one new (empty) table, one enum value, one guard trigger.
-- No existing row/column is read, changed or deleted. Stock is untouched.
-- Idempotent (safe to re-run).

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PURCHASE_REVERSED';

-- ── Linked reversal record (append-only history; at most one per purchase) ──
CREATE TABLE IF NOT EXISTS "purchase_reversals" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reversedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "purchase_reversals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_reversals_reason_nonblank_chk" CHECK (length(btrim("reason")) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "purchase_reversals_purchaseId_key"
    ON "purchase_reversals"("purchaseId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_reversals_purchaseId_fkey') THEN
    ALTER TABLE "purchase_reversals"
      ADD CONSTRAINT "purchase_reversals_purchaseId_fkey"
      FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ── A completed purchase's receiving branch can never be edited directly ──
-- purchases.shopId IS the receiving branch. Corrections use a reversal.
CREATE OR REPLACE FUNCTION purchases_receiving_branch_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'purchases.shopId (receiving branch) is immutable; reverse the purchase instead'
    USING ERRCODE = 'check_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS purchases_receiving_branch_immutable_trg ON "purchases";
CREATE TRIGGER purchases_receiving_branch_immutable_trg
  BEFORE UPDATE OF "shopId" ON "purchases"
  FOR EACH ROW
  WHEN (OLD."shopId" IS DISTINCT FROM NEW."shopId")
  EXECUTE FUNCTION purchases_receiving_branch_immutable();
