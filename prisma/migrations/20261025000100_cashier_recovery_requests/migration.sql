-- Cashier admin-assisted password recovery.
--
-- Purely additive: one new enum, one new EMPTY table, indexes and FKs to
-- users(id). Nothing existing is read, altered, backfilled or dropped.
-- NOT applied to production by this change — requires explicit approval.

CREATE TYPE "CashierRecoveryStatus" AS ENUM
  ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'COMPLETED');

CREATE TABLE "cashier_recovery_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CashierRecoveryStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "codeHash" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "cashier_recovery_requests_pkey" PRIMARY KEY ("id"),
    -- The deadline is exactly 15 minutes after creation and can never be moved
    -- (approval must not restart or extend it).
    CONSTRAINT "cashier_recovery_requests_expiry_15m"
      CHECK ("expiresAt" = "createdAt" + INTERVAL '15 minutes'),
    -- HMAC-SHA256 hex digest only; a raw code can never be stored here.
    CONSTRAINT "cashier_recovery_requests_codeHash_format"
      CHECK ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$'),
    -- A code hash exists exactly while the request is APPROVED.
    CONSTRAINT "cashier_recovery_requests_codeHash_only_when_approved"
      CHECK (("status" = 'APPROVED') = ("codeHash" IS NOT NULL)),
    CONSTRAINT "cashier_recovery_requests_failedAttempts_nonneg"
      CHECK ("failedAttempts" >= 0)
);

CREATE INDEX "cashier_recovery_requests_userId_createdAt_idx" ON "cashier_recovery_requests"("userId", "createdAt");
CREATE INDEX "cashier_recovery_requests_status_expiresAt_idx"  ON "cashier_recovery_requests"("status", "expiresAt");
CREATE INDEX "cashier_recovery_requests_ip_createdAt_idx"      ON "cashier_recovery_requests"("ip", "createdAt");

-- At most ONE active (PENDING or APPROVED) request per cashier. Partial unique
-- indexes are not expressible in schema.prisma; this SQL is the source of truth.
CREATE UNIQUE INDEX "cashier_recovery_one_active_per_user"
  ON "cashier_recovery_requests"("userId")
  WHERE "status" IN ('PENDING', 'APPROVED');

ALTER TABLE "cashier_recovery_requests"
  ADD CONSTRAINT "cashier_recovery_requests_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cashier_recovery_requests"
  ADD CONSTRAINT "cashier_recovery_requests_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Same lock-down as the admin recovery tables: RLS with no policies, and no
-- privileges for Supabase's anon / authenticated roles. Only the backend
-- (table owner) can touch this table.
ALTER TABLE "cashier_recovery_requests" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "cashier_recovery_requests" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "cashier_recovery_requests" FROM authenticated;
  END IF;
END
$$;
