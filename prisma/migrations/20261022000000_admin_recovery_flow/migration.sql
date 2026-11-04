-- Admin password recovery — Phase 3 (Forgot Password flow).
--
-- Additive only: two enum values and ONE new empty table. No existing row,
-- column, index or constraint is read, altered or deleted.
--
-- admin_recovery_challenges deliberately has no foreign key to users: a
-- passkey challenge is issued for any submitted email (known or unknown) so
-- the response cannot be used to enumerate Admin accounts. It stores only a
-- keyed hash of the email, never the email itself.

-- ── Enum additions (not used elsewhere in this migration) ───────────────
ALTER TYPE "AdminRecoveryEvent" ADD VALUE IF NOT EXISTS 'PASSKEY_VERIFICATION';
ALTER TYPE "AdminRecoveryEvent" ADD VALUE IF NOT EXISTS 'PASSWORD_RECOVERED';

-- ── CreateTable: admin_recovery_challenges ──────────────────────────────
CREATE TABLE "admin_recovery_challenges" (
    "id" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "userAgentHash" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_challenges_pkey" PRIMARY KEY ("id"),
    -- HMAC-SHA256 hex digest only; a raw email can never be stored here.
    CONSTRAINT "admin_recovery_challenges_subjectHash_format" CHECK ("subjectHash" ~ '^[0-9a-f]{64}$')
);

-- ── CreateIndex ─────────────────────────────────────────────────────────
CREATE INDEX "admin_recovery_challenges_subjectHash_idx" ON "admin_recovery_challenges"("subjectHash");
CREATE INDEX "admin_recovery_challenges_expiresAt_idx" ON "admin_recovery_challenges"("expiresAt");

-- ── Database-level access restriction ───────────────────────────────────
ALTER TABLE "admin_recovery_challenges" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "admin_recovery_challenges" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "admin_recovery_challenges" FROM authenticated;
  END IF;
END
$$;
