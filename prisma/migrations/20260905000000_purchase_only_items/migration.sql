-- Phase 2A/2B: allow a PurchaseItem to exist without a linked Product,
-- so a purchase can hold "purchase-only" items (one-time / non-catalog
-- items) alongside normal catalog items on the same purchase.
--
-- productId stays the sole discriminator: NULL means the row is a
-- purchase-only item (see schema.prisma comment on PurchaseItem). No
-- existing row is affected — every purchase_items row written so far
-- already has a non-null productId, so this migration only relaxes a
-- constraint; it does not touch data.
--
-- NOTE: this migration was authored by hand (not via `prisma migrate dev`)
-- because this environment's network egress does not allow downloading
-- Prisma's schema-engine binary. Before applying against a real database,
-- run `npx prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --script` (with network
-- access) to confirm this SQL matches what Prisma itself would generate,
-- then `npx prisma migrate dev` to record it normally.

-- ── Drop the old required FK, add back an optional one ──────────────────
ALTER TABLE "purchase_items" DROP CONSTRAINT IF EXISTS "purchase_items_productId_fkey";
ALTER TABLE "purchase_items" ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "purchase_items"
  ADD CONSTRAINT "purchase_items_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── New index to match the updated schema (@@index([productId])) ───────
CREATE INDEX IF NOT EXISTS "purchase_items_productId_idx" ON "purchase_items"("productId");
