-- RBR Egg Mart V2 — Phase 2, Stage 2.3: system_flags (ADDITIVE ONLY).
-- Adds a tiny key/value table and seeds inventory_source = 'CASHIER', i.e.
-- the CURRENT behaviour. Applying this migration changes nothing at runtime:
-- the source only becomes 'BRANCH' when the separately authorized cutover
-- script (prisma/prepared/03_inventory_cutover.sql) runs.
-- Idempotent.
CREATE TABLE IF NOT EXISTS "system_flags" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_flags_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "system_flags_inventory_source_chk"
        CHECK ("key" <> 'inventory_source' OR "value" IN ('CASHIER', 'BRANCH'))
);

INSERT INTO "system_flags" ("key", "value")
VALUES ('inventory_source', 'CASHIER')
ON CONFLICT ("key") DO NOTHING;
