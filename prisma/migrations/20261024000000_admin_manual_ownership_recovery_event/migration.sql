-- Admin password recovery — Phase 5.
-- Audit event for the documented manual ownership-recovery procedure
-- (docs/ADMIN_OWNERSHIP_RECOVERY.md). Additive only; no existing row changes.
ALTER TYPE "AdminRecoveryEvent" ADD VALUE IF NOT EXISTS 'MANUAL_OWNERSHIP_RECOVERY';
