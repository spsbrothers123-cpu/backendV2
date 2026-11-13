# Backend Phase 3 — Test Report

Environment: Node 22, sandbox **without** the Prisma query-engine binary (`binaries.prisma.sh` is unreachable) and no database reachable from Prisma. Real PostgreSQL 16.2 *was* available (pip `pgserver`) and used for SQL-level checks. Nothing below is estimated.

## ✅ Executed — results

| Check | Command | Result |
|---|---|---|
| Pure-logic unit tests (IST, thresholds, stock transitions, FIFO credit ageing, failed-login bursts, summary windows & catch-up, reminder grace, cursor, registry/locking, watermark rules) | `npx vitest run test/notificationsPure.test.ts` | **37 / 37 passed** |
| Route tests, data layer mocked (Central-Admin-only, other-ADMIN 403, client ids ignored, validation, contract shapes/verbs/status, IST date bounds, INVALID_CURSOR, locked Security on both settings APIs) | `npx vitest run test/notificationsRoutes.test.ts` | **15 / 15 passed** |
| Whole existing suite + new tests | `npx vitest run` | **209 passed, 65 failed, 227 skipped.** Baseline (your untouched zip, same sandbox): **157 passed, 65 failed.** The 65 failures are the **same files in both runs** (`adminShops`, `auth`, `cashierShopAssignment`, `multiShopCashiersSessions`, `upi` integration suites + suite-level errors) and every one is the missing Prisma engine. **+52 passed, no regressions.** |
| TypeScript | `npx tsc --noEmit -p tsconfig.json` | **0 errors** (includes all new code and the integration test file) |
| Production build | `npm run build` | **success** |
| Lint | `npx eslint src test --ext .ts` | **0 errors in Phase 3 files** (17 `no-explicit-any` warnings, tests only). Whole repo: 1 error, **pre-existing** in `test/upiAdminRoutes.test.ts` (`prefer-const`), not touched. |
| Prisma schema | `npx prisma validate` (stubbed engine path, dummy URLs) | **valid** |
| Migration on real PG 16 | all 27 existing migrations + the new one applied in order | **applies cleanly** |
| Rollback on real PG 16 | `docs/PHASE3_NOTIFICATIONS_ROLLBACK.sql`, then re-apply | **clean both ways** |
| DB constraints (psql) | immutability trigger rejects body edit / allows `supersededAt`; duplicate `dedupeKey` insert is a no-op; Security preference `enabled=false` rejected by CHECK; bad `HH:MM` rejected; recipient `(notification,user)` unique; delete cascade; legacy `notifications` columns intact | **all behaved as designed** |
| Scheduler lock SQL (real PG, 8 concurrent clients × 25 rounds) | the exact `INSERT … ON CONFLICT … WHERE lockedUntil < now` used by `acquireJob` | **exactly 1 winner every round**; blocked while lease valid; takeover after expiry (crash recovery); stale owner can't release the new holder's lock |
| Idempotent insert race (real PG, 8 concurrent) | the exact `ON CONFLICT ("dedupeKey") DO NOTHING` from `createNotification` | **1 row** |

## ❌ NOT executed
- **`test/notifications.integration.test.ts`** (≈35 DB-backed tests: generation + duplicate prevention, Central Admin vs branch isolation, customer ownership, read/ack independence, deletion rules, retention markers, cursor + page pagination, IST day boundaries, high-value/large-credit/₹0 mismatch thresholds, scheduler lock race, restart/watermark, failing-job recording, summary catch-up + late-night window, reminders, failed-login, announcements immutability/top-up, legacy table untouched). Needs Prisma engine + a disposable DB: `RUN_INTEGRATION_TESTS=1 npx vitest run test/notifications.integration.test.ts`. It type-checks.
- Any Prisma **runtime** path: sweepers, `createNotification` via Prisma `$queryRaw`, inbox queries. The SQL was validated in psql; the Prisma wrapper behaviour (parameter typing of the `::"NtfCategory"` casts, `createMany`, nested `where`) is **unverified at runtime**.
- `prisma migrate deploy` / `migrate diff` (SQL is hand-written; Prisma-vs-SQL drift unchecked — run `prisma migrate diff --from-migrations … --to-schema-datamodel` against a test DB).
- Real `@fastify/rate-limit` behaviour, multi-process scheduler soak, load/performance.
- A truly un-stubbed `prisma validate` / `generate` (only the engine download was stubbed; schema parsing is the real one).
