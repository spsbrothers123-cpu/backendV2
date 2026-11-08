# Admin recovery — Phase 6 test plan and results

## Running

Integration tests need a **disposable local Postgres whose name contains `test`** (`test/setup.ts` refuses anything else) with all migrations applied.

```powershell
# Windows PowerShell
npx prisma migrate deploy
$env:RUN_INTEGRATION_TESTS = "1"; npx vitest run
```
```bash
# macOS / Linux
npx prisma migrate deploy && RUN_INTEGRATION_TESTS=1 npx vitest run
```
Without `RUN_INTEGRATION_TESTS` the database-backed files skip themselves; the DB-free files (`recoveryCrypto`, `recoveryThrottle`, `webauthn`, `trustProxy`, …) always run. Passkey ceremonies use the software authenticator in `test/helpers`, which produces real WebAuthn data, so the production verification path is exercised.

## The 16 required scenarios

Files: **F** = `adminRecoveryFlow`, **S** = `adminSecurity`, **R** = `adminRecovery` (all `.integration.test.ts`).

| # | Scenario | Tests |
| --- | --- | --- |
| 1 | Admin login remains functional | S "POST /api/auth/admin/login still works and the token reaches the new endpoints"; F "existing Admin login still works alongside the new routes" |
| 2 | Optional passkey registration | S "clears the warning with either method alone (both are optional)", "registers a passkey end to end; only public data is stored and exposed", "allows multiple passkeys…" |
| 3 | Successful passkey verification | F "full passkey recovery: options → assertion → grant → reset → login; counter and lastUsedAt advance", "works for the second of several registered passkeys…" |
| 4 | Invalid WebAuthn challenge rejection | F "rejects an assertion for a wrong challenge, and the issued challenge is burned", "rejects an expired challenge", "a challenge is single-use", "rejects a forged signature…"; S "rejects a response bound to a different challenge…" |
| 5 | Generation of eight codes | S "generates eight distinct, well-formed codes; only keyed hashes are stored"; R "generates exactly 8 independent codes and stores only keyed hashes" |
| 6 | Successful recovery-code verification | F "verifies a code, issues a grant, resets the password, and the new password logs in" |
| 7 | Previously used code rejected | F "consumes the code on verification: it cannot be used again, and the other 7 still work"; R "lets a code be used exactly once" |
| 8 | Incorrect code handling | R "rejects wrong, malformed and non-string codes without consuming anything"; F "blocks an account after repeated wrong codes — even for the CORRECT code — with 429" |
| 9 | Concurrent code redemption | R "15 concurrent redemptions → exactly one winner"; F "concurrent redemption of ONE code yields exactly one grant"; `recoveryDb` "exactly one of 20 concurrent redemptions…" |
| 10 | Regeneration | R "regeneration invalidates the previous set…", "never leaves two active sets, even when requested concurrently"; S "regeneration invalidates the previous set and the new set works" |
| 11 | Password update | F "verifies a code, issues a grant, resets the password…", "enforces the existing password policy WITHOUT burning the grant", "a grant is single-use: a replay fails…". **Supabase note:** this codebase has no Supabase Auth (Supabase is only the hosted Postgres); the update is the server-side `users.passwordHash` write, in one transaction with grant consumption and session revocation. |
| 12 | Old-session invalidation | F "revokes the Admin's existing sessions — an already-issued token dies immediately — and nobody else's", "also kills old protected-route access…" |
| 13 | Unauthorized recovery attempts | F "answers identically for a wrong code, unknown email, Cashier email, suspended Admin and Admin with no methods", "another Admin's valid code/passkey never works…", "rejects malformed, random and missing grants", "the recovery routes ignore Authorization headers…"; `recoveryClientIp` (forged X-Forwarded-For) |
| 14 | Admin / Cashier role isolation | S "rejects a Cashier (403) on every route and never creates credentials for them"; F "a Cashier can never be recovered…"; R "only ever issues codes to an ACTIVE ADMIN" |
| 15 | No recovery method configured | F "an Admin with NO recovery method cannot be reset by any route, and no grant is ever issued"; S "reports no recovery method configured for a fresh Admin" |
| 16 | Recovery audit logging | F "records verification, grant issue, grant consumption and password recovery — keyed by account, no secrets", "never stores or exposes the raw code, grant token or new password in any audit row"; S "records generate, regenerate, register, remove and failed re-auth — with no secrets" |

## Added in Phases 4–6

`recoveryDb` (CHECK constraints, atomic consumption, retention purge, RLS), `trustProxy` (parser + real-Fastify IP derivation, DB-free), `recoveryClientIp` (per-IP limit holds against forged `X-Forwarded-For`; proven to **fail** with the old `trustProxy: true`).

## Results of the Phase 6 run

Run against PostgreSQL 16 with all 16 migrations applied: **336 passed, 1 failed (337)**, `tsc --noEmit` clean.

The single failure, `billing › payment idempotency (§46)`, is an artefact of the sandbox, not of recovery work: the sandbox could not download Prisma 5's native engine, so the suite ran on Prisma 6.19's engine-free client, and `billingService.ts` imports the error class from the Prisma 5 path `@prisma/client/runtime/library.js`, which is a different class there, so its `instanceof` check misses. No billing code or table was touched. **Please confirm the full suite on your machine under Prisma 5.**

Fixes made while running: `routes/auth.ts` had a TypeScript error (TS2367, an unreachable Admin comparison in the Cashier-only reset path) — simplified; four expired-row fixtures now backdate `createdAt` as well (needed by the Phase 4 expiry CHECKs); two assertions read the now-`BIGINT` passkey counter via `Number()`; two catalog queries cast `relname::text`.
