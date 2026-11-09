-- Admin Security Settings — Phase 2 (passkeys + recovery-code management).
--
-- Additive only: adds enum values, one enum, and two NEW tables. No existing
-- row, column, index or constraint is read, altered or deleted.
--
-- Every table keys to users("id") — the app's own auth table — so there is no
-- duplicate user/auth table. These tables are server-only: RLS is enabled with
-- NO policies and the Supabase `anon` / `authenticated` roles are revoked (same
-- approach as 20261020000000_admin_recovery_foundation).

-- ── Enum additions (not used elsewhere in this migration) ───────────────
ALTER TYPE "AdminRecoveryMethod" ADD VALUE IF NOT EXISTS 'PASSKEY';
ALTER TYPE "AdminRecoveryEvent" ADD VALUE IF NOT EXISTS 'REAUTH_FAILED';
ALTER TYPE "AdminRecoveryEvent" ADD VALUE IF NOT EXISTS 'PASSKEY_REGISTERED';
ALTER TYPE "AdminRecoveryEvent" ADD VALUE IF NOT EXISTS 'PASSKEY_REGISTRATION_FAILED';
ALTER TYPE "AdminRecoveryEvent" ADD VALUE IF NOT EXISTS 'PASSKEY_REMOVED';

CREATE TYPE "AdminPasskeyChallengePurpose" AS ENUM ('REGISTRATION');

-- ── CreateTable: admin_passkeys ─────────────────────────────────────────
CREATE TABLE "admin_passkeys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "userHandle" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "admin_passkeys_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_passkeys_credentialId_format" CHECK ("credentialId" ~ '^[A-Za-z0-9_-]{1,1024}$'),
    CONSTRAINT "admin_passkeys_name_length" CHECK (char_length("name") BETWEEN 1 AND 60)
);

-- ── CreateTable: admin_passkey_challenges ───────────────────────────────
CREATE TABLE "admin_passkey_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "AdminPasskeyChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "userHandle" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_passkey_challenges_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "admin_passkeys_credentialId_key" ON "admin_passkeys"("credentialId");
CREATE INDEX "admin_passkeys_userId_idx" ON "admin_passkeys"("userId");
CREATE INDEX "admin_passkey_challenges_userId_purpose_idx" ON "admin_passkey_challenges"("userId", "purpose");
CREATE INDEX "admin_passkey_challenges_expiresAt_idx" ON "admin_passkey_challenges"("expiresAt");

-- ── AddForeignKey ───────────────────────────────────────────────────────
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_passkey_challenges" ADD CONSTRAINT "admin_passkey_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Database-level access restriction ───────────────────────────────────
ALTER TABLE "admin_passkeys"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_passkey_challenges" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "admin_passkeys", "admin_passkey_challenges" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "admin_passkeys", "admin_passkey_challenges" FROM authenticated;
  END IF;
END
$$;
