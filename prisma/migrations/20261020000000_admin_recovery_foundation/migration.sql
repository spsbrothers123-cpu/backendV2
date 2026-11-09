-- Admin password recovery — Phase 1 foundation (recovery codes only).
--
-- Purely additive: creates three enums and three NEW empty tables. It does
-- not read, backfill, alter or delete any existing row, column, index or
-- constraint. Passkey tables are intentionally NOT part of this migration
-- (they wait on the production-domain decision).
--
-- Every table keys to users("id") — the app's own auth table — so there is
-- no duplicate user/auth table. These tables hold recovery credentials, so
-- they are locked down at the database level in addition to being reachable
-- only through the backend (see the RLS section at the bottom).

-- ── CreateEnum ──────────────────────────────────────────────────────────
CREATE TYPE "AdminRecoveryMethod" AS ENUM ('RECOVERY_CODE');
CREATE TYPE "AdminRecoveryEvent" AS ENUM (
  'CODES_GENERATED',
  'CODES_REGENERATED',
  'CODE_VERIFICATION',
  'GRANT_ISSUED',
  'GRANT_CONSUMED',
  'ATTEMPT_THROTTLED'
);
CREATE TYPE "AdminRecoveryOutcome" AS ENUM ('SUCCESS', 'FAILURE');

-- ── CreateTable: admin_recovery_codes ───────────────────────────────────
CREATE TABLE "admin_recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "setId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_codes_pkey" PRIMARY KEY ("id"),
    -- HMAC-SHA256 hex digest only; a raw code can never be stored here.
    CONSTRAINT "admin_recovery_codes_codeHash_format" CHECK ("codeHash" ~ '^[0-9a-f]{64}$')
);

-- ── CreateTable: admin_recovery_grants ──────────────────────────────────
CREATE TABLE "admin_recovery_grants" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" "AdminRecoveryMethod" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgentHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_grants_pkey" PRIMARY KEY ("id"),
    -- SHA-256 hex digest only; the raw grant token is never stored.
    CONSTRAINT "admin_recovery_grants_tokenHash_format" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')
);

-- ── CreateTable: admin_recovery_audit ───────────────────────────────────
CREATE TABLE "admin_recovery_audit" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "subjectHash" TEXT,
    "event" "AdminRecoveryEvent" NOT NULL,
    "outcome" "AdminRecoveryOutcome" NOT NULL,
    "method" "AdminRecoveryMethod",
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recovery_audit_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ─────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "admin_recovery_codes_userId_codeHash_key" ON "admin_recovery_codes"("userId", "codeHash");
CREATE INDEX "admin_recovery_codes_userId_setId_idx" ON "admin_recovery_codes"("userId", "setId");

CREATE UNIQUE INDEX "admin_recovery_grants_tokenHash_key" ON "admin_recovery_grants"("tokenHash");
CREATE INDEX "admin_recovery_grants_userId_idx" ON "admin_recovery_grants"("userId");
CREATE INDEX "admin_recovery_grants_expiresAt_idx" ON "admin_recovery_grants"("expiresAt");

CREATE INDEX "admin_recovery_audit_subjectHash_createdAt_idx" ON "admin_recovery_audit"("subjectHash", "createdAt");
CREATE INDEX "admin_recovery_audit_ip_createdAt_idx" ON "admin_recovery_audit"("ip", "createdAt");
CREATE INDEX "admin_recovery_audit_userId_createdAt_idx" ON "admin_recovery_audit"("userId", "createdAt");

-- ── AddForeignKey ───────────────────────────────────────────────────────
ALTER TABLE "admin_recovery_codes" ADD CONSTRAINT "admin_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "admin_recovery_grants" ADD CONSTRAINT "admin_recovery_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Audit history outlives the account row: SET NULL, not CASCADE.
ALTER TABLE "admin_recovery_audit" ADD CONSTRAINT "admin_recovery_audit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Database-level access restriction ───────────────────────────────────
-- Supabase auto-exposes tables in the public schema through its Data API
-- (PostgREST) to the `anon` / `authenticated` roles. This app never uses
-- that API, and recovery credentials must never be readable or modifiable
-- from a client. So: enable RLS with NO policies (deny-all for any role
-- that is subject to RLS) and revoke the table privileges from those two
-- roles outright. The backend connects as the table owner, which is
-- unaffected. The role checks keep this migration runnable on a plain
-- local Postgres (e.g. the integration-test database) that has no such
-- roles.
ALTER TABLE "admin_recovery_codes"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_recovery_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_recovery_audit"  ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "admin_recovery_codes", "admin_recovery_grants", "admin_recovery_audit" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "admin_recovery_codes", "admin_recovery_grants", "admin_recovery_audit" FROM authenticated;
  END IF;
END
$$;
