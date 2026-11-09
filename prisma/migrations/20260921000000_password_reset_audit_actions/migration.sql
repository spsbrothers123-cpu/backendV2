-- RBR Egg Mart V2 Phase 1: Forgot Password (Admin + Cashier).
-- Adds two AuditAction values so password-reset requests/completions are
-- recorded the same way every other security-relevant event is (see
-- lib/audit.ts). Purely additive — no existing rows or columns change.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PASSWORD_RESET_COMPLETED';
