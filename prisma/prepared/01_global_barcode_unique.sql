-- PREPARED, NOT APPLIED. Global barcode uniqueness (Phase 2 Stage 2.1 prep).
-- Existing @@unique([shopId, barcode]) is KEPT (nothing dropped); this adds a
-- stricter, global, case/whitespace-insensitive rule on top.
-- Nulls and blank barcodes are exempt (many products legitimately have none).
-- Covers ALL products including INACTIVE ones, so a deactivated product's
-- barcode cannot be silently reused.
BEGIN;

-- Pre-flight: abort if any normalized barcode appears on more than one product.
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM (
        SELECT lower(btrim("barcode")) AS b
        FROM "products"
        WHERE "barcode" IS NOT NULL AND btrim("barcode") <> ''
        GROUP BY 1 HAVING count(*) > 1
    ) d;
    IF n > 0 THEN
        RAISE EXCEPTION 'Global barcode constraint blocked: % barcode value(s) are used by more than one product. Resolve via the approved Q4 manual decision first (list them with the SELECT in this file''s footer).', n;
    END IF;
END $$;

CREATE UNIQUE INDEX "products_barcode_global_unique_idx"
    ON "products" (lower(btrim("barcode")))
    WHERE "barcode" IS NOT NULL AND btrim("barcode") <> '';

COMMIT;

-- Diagnostic (read-only), to list conflicts:
-- SELECT lower(btrim(barcode)) AS barcode, count(*) AS products,
--        string_agg(id || ' (shop ' || "shopId" || ', ' || status::text || ')', '; ') AS rows
-- FROM products WHERE barcode IS NOT NULL AND btrim(barcode) <> ''
-- GROUP BY 1 HAVING count(*) > 1;
--
-- Rollback: DROP INDEX IF EXISTS "products_barcode_global_unique_idx";
