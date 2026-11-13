-- Backend Phase 3 (B3.1) — notification engine foundation.
-- PURELY ADDITIVE (D-26): the legacy "notifications" table, its enum and every
-- other existing table are untouched. Rollback: docs/PHASE3_NOTIFICATIONS_ROLLBACK.sql

CREATE TYPE "NtfCategory" AS ENUM ('INVENTORY','CASHIER','CREDIT','SALES_PURCHASES','SECURITY','DAILY_SUMMARY','SESSION','ACCOUNT_SECURITY','ANNOUNCEMENT');
CREATE TYPE "NtfSeverity" AS ENUM ('INFO','WARNING','CRITICAL');
CREATE TYPE "NtfStockState" AS ENUM ('OK','LOW','OUT');
CREATE TYPE "AnnouncementAudience" AS ENUM ('ALL_CASHIERS','INDIVIDUAL');
CREATE TYPE "DailySummaryKind" AS ENUM ('MAIN','SUPPLEMENTARY');

CREATE TABLE "announcements" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "audience" "AnnouncementAudience" NOT NULL,
  "targetCashierId" TEXT,
  "requiresAcknowledgement" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "supersedesId" TEXT,
  "supersededAt" TIMESTAMP(3),
  CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app_notifications" (
  "id" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "category" "NtfCategory" NOT NULL,
  "type" TEXT NOT NULL,
  "severity" "NtfSeverity" NOT NULL DEFAULT 'INFO',
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "shopId" TEXT,
  "targetKind" TEXT,
  "targetId" TEXT,
  "targetRoute" TEXT,
  "announcementId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "app_notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_notifications_expiry_check" CHECK ("expiresAt" > "createdAt")
);

CREATE TABLE "app_notification_recipients" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "readAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "app_notification_recipients_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_preferences" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "category" "NtfCategory" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id"),
  -- D-07 / D-27: Security categories can never be switched off, even by direct SQL.
  CONSTRAINT "notification_preferences_security_locked_check"
    CHECK ("enabled" = true OR "category" NOT IN ('SECURITY','ACCOUNT_SECURITY'))
);

CREATE TABLE "branch_notification_settings" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "openingTime" TEXT,
  "closingTime" TEXT,
  "highValueSaleThreshold" DECIMAL(12,2),
  "largeCreditThreshold" DECIMAL(12,2),
  "creditOverdueDays" INTEGER,
  "updatedById" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_notification_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bns_opening_time_check" CHECK ("openingTime" IS NULL OR "openingTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "bns_closing_time_check" CHECK ("closingTime" IS NULL OR "closingTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "bns_thresholds_check" CHECK (
    ("highValueSaleThreshold" IS NULL OR "highValueSaleThreshold" > 0) AND
    ("largeCreditThreshold" IS NULL OR "largeCreditThreshold" > 0) AND
    ("creditOverdueDays" IS NULL OR "creditOverdueDays" > 0)
  )
);

CREATE TABLE "branch_product_low_stock" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "lowStockThreshold" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "branch_product_low_stock_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bpls_threshold_check" CHECK ("lowStockThreshold" >= 0)
);

CREATE TABLE "notification_stock_states" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "state" "NtfStockState" NOT NULL,
  "seq" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_stock_states_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notification_job_state" (
  "key" TEXT NOT NULL,
  "lockedBy" TEXT,
  "lockedUntil" TIMESTAMP(3),
  "lastStartedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "cursorAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_job_state_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "daily_summaries" (
  "id" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "kind" "DailySummaryKind" NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metrics" JSONB NOT NULL,
  "branches" JSONB NOT NULL,
  CONSTRAINT "daily_summaries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "daily_summaries_date_check" CHECK ("businessDate" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

-- Unique constraints / indexes
CREATE UNIQUE INDEX "announcements_supersedesId_key" ON "announcements"("supersedesId");
CREATE INDEX "announcements_createdAt_idx" ON "announcements"("createdAt");
CREATE UNIQUE INDEX "app_notifications_dedupeKey_key" ON "app_notifications"("dedupeKey");
CREATE INDEX "app_notifications_shopId_createdAt_idx" ON "app_notifications"("shopId","createdAt");
CREATE INDEX "app_notifications_expiresAt_idx" ON "app_notifications"("expiresAt");
CREATE INDEX "app_notifications_announcementId_idx" ON "app_notifications"("announcementId");
CREATE UNIQUE INDEX "app_notification_recipients_notificationId_userId_key" ON "app_notification_recipients"("notificationId","userId");
CREATE INDEX "app_notification_recipients_userId_createdAt_id_idx" ON "app_notification_recipients"("userId","createdAt" DESC,"id");
-- Unread badge counts: only live, unread rows.
CREATE INDEX "app_notification_recipients_unread_idx" ON "app_notification_recipients"("userId") WHERE "readAt" IS NULL AND "deletedAt" IS NULL;
CREATE UNIQUE INDEX "notification_preferences_userId_category_key" ON "notification_preferences"("userId","category");
CREATE UNIQUE INDEX "branch_notification_settings_shopId_key" ON "branch_notification_settings"("shopId");
CREATE UNIQUE INDEX "branch_product_low_stock_shopId_productId_key" ON "branch_product_low_stock"("shopId","productId");
CREATE UNIQUE INDEX "notification_stock_states_shopId_productId_key" ON "notification_stock_states"("shopId","productId");
CREATE UNIQUE INDEX "daily_summaries_businessDate_kind_key" ON "daily_summaries"("businessDate","kind");

-- Foreign keys
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_targetCashierId_fkey" FOREIGN KEY ("targetCashierId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "announcements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "app_notification_recipients" ADD CONSTRAINT "app_notification_recipients_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "app_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_notification_recipients" ADD CONSTRAINT "app_notification_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_notification_settings" ADD CONSTRAINT "branch_notification_settings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_product_low_stock" ADD CONSTRAINT "branch_product_low_stock_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "branch_product_low_stock" ADD CONSTRAINT "branch_product_low_stock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- D-21: published announcement content must never be silently edited. Only the
-- bookkeeping columns (supersededAt, and FK nulling on user deletion) may change.
CREATE OR REPLACE FUNCTION announcements_immutable_content() RETURNS trigger AS $$
BEGIN
  IF NEW."title" IS DISTINCT FROM OLD."title"
     OR NEW."body" IS DISTINCT FROM OLD."body"
     OR NEW."audience" IS DISTINCT FROM OLD."audience"
     OR NEW."requiresAcknowledgement" IS DISTINCT FROM OLD."requiresAcknowledgement"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'Published announcement content is immutable; publish a revision instead.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER announcements_immutable_content_trg
  BEFORE UPDATE ON "announcements"
  FOR EACH ROW EXECUTE FUNCTION announcements_immutable_content();
