# Backend Notification Database Schema

Migration: `prisma/migrations/20261111000000_phase3_notification_engine/migration.sql` (additive only). Rollback: `docs/PHASE3_NOTIFICATIONS_ROLLBACK.sql`.
**Untouched:** legacy `notifications` table and enum `NotificationType`, and every column of every existing table (Prisma schema gained 8 back-relation lines only; these produce no SQL).

| Table | Purpose | Key constraints / indexes |
|---|---|---|
| `app_notifications` | one event per audience | **UNIQUE `dedupeKey`** (idempotency); CHECK `expiresAt > createdAt`; idx `(shopId,createdAt)`, `(expiresAt)`, `(announcementId)`; FK `shopId` SET NULL |
| `app_notification_recipients` | per-user state: `readAt`, `acknowledgedAt`, `deletedAt` (independent) | **UNIQUE `(notificationId,userId)`**; idx `(userId,createdAt DESC,id)`; partial idx unread `(userId) WHERE readAt IS NULL AND deletedAt IS NULL`; FK cascade from notification and user |
| `notification_preferences` | per-user category switches (D-27) | UNIQUE `(userId,category)`; **CHECK: SECURITY / ACCOUNT_SECURITY can't be `enabled=false`** |
| `announcements` | admin composer (D-21) | **trigger blocks edits of title/body/audience/requiresAcknowledgement/createdAt**; `supersedesId` UNIQUE (one revision) |
| `branch_notification_settings` | nullable per-branch IST `openingTime`/`closingTime` (`HH:MM` CHECK), thresholds, `creditOverdueDays` | UNIQUE `shopId`; positive-value CHECKs |
| `branch_product_low_stock` | D-17 per-branch product threshold override | UNIQUE `(shopId,productId)`; CHECK ≥ 0 |
| `notification_stock_states` | last stock state + `seq` per (branch,product) → one alert per transition | UNIQUE `(shopId,productId)` |
| `notification_job_state` | scheduler **lease lock** + watermark per job | PK `key`; `lockedBy`,`lockedUntil`,`cursorAt`,`lastError`,`failureCount` |
| `daily_summaries` | stored summaries (MAIN / SUPPLEMENTARY) | UNIQUE `(businessDate,kind)`; date-format CHECK |

Enums: `NtfCategory`, `NtfSeverity`, `NtfStockState`, `AnnouncementAudience`, `DailySummaryKind`.
Retention (D-10): notification + recipients (incl. deletion markers) deleted when `expiresAt` (= createdAt + 90 days) passes; summaries older than 90 IST days purged.
Timestamps are naive-UTC `timestamp(3)` (Prisma convention); raw SQL casts ISO strings with `::timestamp` so results don't depend on session TimeZone.
