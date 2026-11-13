# Backend Phase 3 — Notification Engine: Implementation Report

**Status:** B3.1–B3.7 implemented. **B3.8 (push) deferred per D-25.** Nothing pushed, deployed, or applied to any real database.
**Verification caveat (read first):** the sandbox could not download the Prisma query engine, so **no code that talks to Prisma was executed against a database**. What *was* executed is listed honestly in `BACKEND_NOTIFICATION_TEST_REPORT.md`. The DB-backed suite (`test/notifications.integration.test.ts`) is written, type-checked and ready, but **has not been run**. Run it before trusting this in production.

Authority used: D-01…D-26, D-27 (settings endpoints), the audit report, and both frontend API contracts. No decision was changed.

## What was built, by subphase

| Subphase | Delivered |
|---|---|
| **B3.1 Database** | 9 new tables, 5 new enums, constraints, indexes, immutability trigger, hand-written migration + rollback script. Legacy `notifications` untouched (D-26). |
| **B3.2 Core** | `createNotification` (atomic, idempotent via `ON CONFLICT ("dedupeKey") DO NOTHING`), Central Admin / branch-Cashier / customer-owner recipient resolution, per-category preferences, read / acknowledge / delete state, push-ready delivery seam. |
| **B3.3 APIs** | Admin + Cashier endpoints per the two contracts (D-01), unread-count and `GET /:id` (D-12), settings endpoints for both (D-27), per-route rate limits. |
| **B3.4 Detection** | Background sweepers over existing tables (D-23): stock transitions, high-value, large-credit, session opened/closed, cash mismatch, credit cleared/adjusted/overdue. No billing/inventory/session code modified. |
| **B3.5 Scheduler** | In-process scheduler, DB lease lock, persisted watermarks, restart catch-up, failure recording (D-24). |
| **B3.6 Advanced** | Security (failed-login D-20, admin password recovery, cashier recovery requests), account events, opening/closing reminders (D-18), announcements composer (D-21), two daily summaries with the 12 metrics (D-22). |
| **B3.7 Validation** | See test report. |

## Requirement map (spec §3 items 1–18)
1 shared service `src/notifications/service.ts` · 2 generation `sweepers/*` · 3 persistence `app_notifications`+`app_notification_recipients` · 4 Central Admin targeting `recipients.ts` · 5 branch Cashier targeting `recipients.ts` · 6 read/unread `inbox.ts` · 7 acknowledgement `inbox.ts` · 8 deletion+retention `inbox.ts`, `sweepers/retention.ts` · 9 retrieval · 10 unread counts · 11 pagination (page/pageSize + cursor) · 12 IST filtering `lib/ist.ts` · 13 idempotency (unique `dedupeKey`) · 14 detection `sweepers/` · 15–16 `scheduler.ts`, `jobState.ts`, `schedule.ts`, `dailySummary.ts` · 17 `announcements.ts` · 18 `sweepers/security.ts`.

## Key design decisions (all inside the approved decisions)
- **One event row per audience.** Admin and Cashier categories differ (D-03), so each event is stored once per audience; dedupe key = `type|AUDIENCE|key`. Recipient rows hold per-user `readAt` / `acknowledgedAt` / `deletedAt` (D-04, D-11). Deletion marker = `deletedAt`, kept until the notification's `expiresAt` (D-10).
- **Central Admin** = `CENTRAL_ADMIN_USER_ID` only, fail-closed. Other ADMINs get **403 CENTRAL_ADMIN_REQUIRED** on the Admin notification routes.
- **Stock alerts** use a `notification_stock_states` table (state + `seq`); state change and notification commit in **one transaction**, so no lost or repeated alert (D-23). Thresholds: branch override → `Product.lowStockThreshold` (D-17), one helper.
- **Thresholds** live in `NOTIFICATION_DEFAULTS` + `branch_notification_settings` (nullable overrides). Money compared in integer cents, `>=` (D-19).
- **Security locked ON** in three layers: API (Cashier 403 / Admin ignore), service (never filtered), **DB CHECK constraint**.
- **Announcements** immutable via DB trigger; corrections via `POST /:id/revise` (supersedes). No update/delete endpoint exists.
- **Push seam** only: `src/notifications/delivery.ts` + `NOTIFICATION_PUSH_ENABLED` (default false). No FCM code.

## Files
**Added:** `src/lib/ist.ts`; `src/notifications/{constants,config,thresholds,recipients,service,preferences,inbox,cursor,serializers,delivery,jobState,scheduler,schedule,jobs,dailySummary,announcements}.ts`; `src/notifications/sweepers/{types,util,inventory,bills,credit,sessions,security,reminders,dailySummary,announcements,retention}.ts`; `src/routes/notifications.ts`; `src/routes/admin/{notificationSettings,announcements,dailySummaries,branchNotificationSettings}.ts`; `prisma/migrations/20261111000000_phase3_notification_engine/migration.sql`; `docs/PHASE3_NOTIFICATIONS_ROLLBACK.sql`; `test/notificationsPure.test.ts`, `test/notificationsRoutes.test.ts`, `test/notifications.integration.test.ts`.
**Modified:** `prisma/schema.prisma` (new models + 8 back-relation lines on `Shop`/`User`/`Product`; **no column of any existing table changed**), `src/app.ts` (route registration), `src/server.ts` (scheduler start), `src/config/env.ts` (2 optional flags), `src/routes/admin/notifications.ts` (rewritten onto the new tables, same path/verbs), `test/dbReset.ts` (clears new tables).

## Migration / rollout
1. Back up. 2. `prisma migrate deploy` (purely additive; no locks on business tables beyond FK metadata). 3. Confirm `CENTRAL_ADMIN_USER_ID` is set in production. 4. Deploy; the scheduler starts automatically (`NOTIFICATION_SCHEDULER_ENABLED=false` to run an instance API-only). 5. **Expect a one-time burst** of low/out-of-stock alerts on the first sweep for products already low (first observation of a low/out state alerts). Rollback: `docs/PHASE3_NOTIFICATIONS_ROLLBACK.sql`.
No production env var was changed; both new vars are optional.

## Behaviour changes to be aware of
- `GET /api/admin/notifications` now returns `{items,total,page,pageSize,unreadCount}` (Admin contract) instead of a bare array; the legacy `time` field is still included.
- Non-central ADMIN accounts get 403 on Admin notification routes (previously shop-scoped data from the legacy table).
