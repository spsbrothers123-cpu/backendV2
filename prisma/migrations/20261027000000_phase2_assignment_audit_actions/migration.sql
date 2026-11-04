-- RBR Egg Mart V2 — Phase 2, Stage 2.2: audit actions for branch
-- (un)assignment. Purely additive — no existing rows or columns change.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRODUCT_ASSIGNED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRODUCT_UNASSIGNED';
