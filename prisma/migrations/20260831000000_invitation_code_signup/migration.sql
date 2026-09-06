-- Remove the cashier-signup email-OTP system and replace it with an
-- admin-generated 6-digit invitation code system.
--
-- NOTE: this migration was authored by hand (not via `prisma migrate dev`)
-- because this environment's network egress does not allow downloading
-- Prisma's schema-engine binary. Before applying against a real database,
-- run `npx prisma migrate diff --from-migrations prisma/migrations
-- --to-schema-datamodel prisma/schema.prisma --script` (with network
-- access) to confirm this SQL matches what Prisma itself would generate,
-- then `npx prisma migrate dev` to record it normally.

-- ── Drop the old cashier-signup OTP table ────────────────────────────────
ALTER TABLE "signup_verifications" DROP CONSTRAINT IF EXISTS "signup_verifications_userId_fkey";
DROP TABLE IF EXISTS "signup_verifications";

-- ── AccountStatus: drop PENDING_EMAIL_VERIFICATION ──────────────────────
-- No cashier reaches this status via the new flow (signup goes straight to
-- PENDING_ADMIN_APPROVAL). Postgres enums can't drop a value in place, so
-- recreate the type. No existing rows should reference the removed value
-- once this migration ships (any that do must be moved to
-- PENDING_ADMIN_APPROVAL first — see the UPDATE below, included for
-- safety on a database migrating from Phase 1).
UPDATE "users" SET "status" = 'PENDING_ADMIN_APPROVAL' WHERE "status" = 'PENDING_EMAIL_VERIFICATION';

ALTER TYPE "AccountStatus" RENAME TO "AccountStatus_old";
CREATE TYPE "AccountStatus" AS ENUM ('PENDING_ADMIN_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED');
ALTER TABLE "users" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "status" TYPE "AccountStatus" USING ("status"::text::"AccountStatus");
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
DROP TYPE "AccountStatus_old";

-- ── AuditAction: drop the OTP actions, add invitation-code actions ──────
ALTER TYPE "AuditAction" RENAME TO "AuditAction_old";
CREATE TYPE "AuditAction" AS ENUM (
  'LOGIN', 'LOGOUT', 'LOGIN_FAILED',
  'CASHIER_SIGNUP_REQUESTED', 'CASHIER_APPROVED', 'CASHIER_REJECTED', 'CASHIER_UPDATED', 'CASHIER_STATUS_CHANGED',
  'INVITATION_CODE_GENERATED', 'INVITATION_CODE_REVOKED', 'INVITATION_CODE_USED',
  'SESSION_OPENED', 'SESSION_CLOSED',
  'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_DELETED',
  'CUSTOMER_CREATED', 'CUSTOMER_UPDATED',
  'BILL_CREATED', 'BILL_HELD', 'BILL_RESUMED', 'BILL_HELD_DELETED',
  'PAYMENT_CREATED', 'SPLIT_PAYMENT_CREATED', 'CREDIT_PAYMENT_CREATED',
  'INVENTORY_ADJUSTED', 'PURCHASE_CREATED',
  'EXPENSE_CREATED', 'EXPENSE_UPDATED', 'EXPENSE_DELETED',
  'PROFILE_UPDATED', 'SETTINGS_UPDATED'
);
-- Any historical rows referencing a removed OTP action are recoded to the
-- nearest still-existing action rather than deleted, so audit history
-- stays intact.
ALTER TABLE "audit_logs" ALTER COLUMN "action" TYPE TEXT USING ("action"::text);
UPDATE "audit_logs" SET "action" = 'CASHIER_SIGNUP_REQUESTED' WHERE "action" IN ('CASHIER_OTP_SENT', 'CASHIER_OTP_FAILED', 'CASHIER_EMAIL_VERIFIED');
ALTER TABLE "audit_logs" ALTER COLUMN "action" TYPE "AuditAction" USING ("action"::"AuditAction");
DROP TYPE "AuditAction_old";

-- ── InvitationCodeStatus ─────────────────────────────────────────────────
CREATE TYPE "InvitationCodeStatus" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED');

-- ── users: masked invitation-code reference ─────────────────────────────
ALTER TABLE "users" ADD COLUMN "invitationCodeMasked" TEXT;

-- ── CreateTable: invitation_codes ────────────────────────────────────────
CREATE TABLE "invitation_codes" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codePlain" TEXT,
    "status" "InvitationCodeStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdByAdminId" TEXT NOT NULL,
    "usedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitation_codes_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ──────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "invitation_codes_usedByUserId_key" ON "invitation_codes"("usedByUserId");
CREATE INDEX "invitation_codes_shopId_idx" ON "invitation_codes"("shopId");
CREATE INDEX "invitation_codes_codeHash_idx" ON "invitation_codes"("codeHash");
CREATE INDEX "invitation_codes_status_idx" ON "invitation_codes"("status");

-- ── AddForeignKey ────────────────────────────────────────────────────────
ALTER TABLE "invitation_codes" ADD CONSTRAINT "invitation_codes_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invitation_codes" ADD CONSTRAINT "invitation_codes_createdByAdminId_fkey" FOREIGN KEY ("createdByAdminId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invitation_codes" ADD CONSTRAINT "invitation_codes_usedByUserId_fkey" FOREIGN KEY ("usedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
