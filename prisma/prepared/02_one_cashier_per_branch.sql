-- PREPARED, NOT APPLIED. One ACTIVE or PENDING_ADMIN_APPROVAL Cashier per branch.
-- REJECTED / SUSPENDED Cashiers are exempt, so a replaced Cashier can be
-- suspended (history, bills, sessions all preserved) before the replacement
-- is approved. Nothing is deleted or reassigned by this script.
BEGIN;

-- Pre-flight: abort if any branch already violates the rule.
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM (
        SELECT "shopId"
        FROM "users"
        WHERE "role" = 'CASHIER'
          AND "status" IN ('ACTIVE', 'PENDING_ADMIN_APPROVAL')
          AND "shopId" IS NOT NULL
        GROUP BY "shopId" HAVING count(*) > 1
    ) d;
    IF n > 0 THEN
        RAISE EXCEPTION 'One-cashier-per-branch constraint blocked: % branch(es) have more than one ACTIVE/PENDING_ADMIN_APPROVAL Cashier. The owner must decide which Cashier stays (Stage 2.4 rule) before this can be applied.', n;
    END IF;
END $$;

CREATE UNIQUE INDEX "users_one_open_cashier_per_shop_idx"
    ON "users" ("shopId")
    WHERE "role" = 'CASHIER'
      AND "status" IN ('ACTIVE', 'PENDING_ADMIN_APPROVAL')
      AND "shopId" IS NOT NULL;

COMMIT;

-- Diagnostic (read-only), to list conflicts:
-- SELECT "shopId", count(*), string_agg(email || ' [' || status::text || ']', ', ' ORDER BY "createdAt")
-- FROM users WHERE role='CASHIER' AND status IN ('ACTIVE','PENDING_ADMIN_APPROVAL') AND "shopId" IS NOT NULL
-- GROUP BY 1 HAVING count(*) > 1;
--
-- Rollback: DROP INDEX IF EXISTS "users_one_open_cashier_per_shop_idx";
