-- RBR Egg Mart V2 — Phase 2, Stage 2.5: audit actions for branch price
-- overrides. Purely additive — no existing rows, columns or constraints
-- change. (branch_products.priceOverride and its CHECK (>= 0) already exist
-- from Stage 2.1.)
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRICE_OVERRIDE_SET';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PRICE_OVERRIDE_CLEARED';
