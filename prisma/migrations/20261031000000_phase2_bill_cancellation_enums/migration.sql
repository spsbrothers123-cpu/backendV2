-- RBR Egg Mart V2 — Phase 2, Stage 2.7 (1/2): enum values for bill cancellation.
-- Purely additive. Kept in its own migration because a newly added enum value
-- cannot be referenced (e.g. by an index predicate) until it is committed.
ALTER TYPE "AuditAction"   ADD VALUE IF NOT EXISTS 'BILL_CANCELLED';
ALTER TYPE "CreditTxnType" ADD VALUE IF NOT EXISTS 'REVERSAL';
