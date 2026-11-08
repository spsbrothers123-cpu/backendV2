# Admin recovery — Phase 5 security review

Scope: `/api/auth/admin/recovery/*`, `/api/admin/security/*`, and the tables `admin_passkeys`, `admin_passkey_challenges`, `admin_recovery_codes`, `admin_recovery_grants`, `admin_recovery_challenges`, `admin_recovery_audit`. Every control below was read in code; the "Test" column names the test that proves it. Tests marked **(DB)** need `RUN_INTEGRATION_TESTS=1` and a disposable Postgres; the rest run anywhere.

| Threat | Control | Test |
| --- | --- | --- |
| Brute force | 5 free failures / account / 15 min (codes **and** passkeys share one budget), then 30 s → 15 min escalation; 20 failures / IP / hour; route limiter 10 / 10 min / IP; 160-bit codes; WebAuthn needs a valid signature. **Client IP is now un-spoofable** (see finding 1). | `recoveryThrottle.test.ts`; adminRecoveryFlow "blocks an account after repeated wrong codes", "passkey and code failures share ONE per-account budget" (DB); `trustProxy.test.ts` |
| Recovery-code reuse | Atomic `UPDATE … WHERE usedAt IS NULL AND revokedAt IS NULL`; HMAC keyed with a pepper and bound to the user id | adminRecovery "lets a code be used exactly once", "15 concurrent redemptions → exactly one winner" (DB); `recoveryDb.integration.test.ts` (DB) |
| Concurrent requests | Conditional updates for codes, grants, challenges and the passkey counter; `FOR UPDATE` on the user row for reset, generation and registration | adminRecoveryFlow "concurrent redemption of ONE code/grant/challenge" (DB) |
| Replay | Challenges consumed *before* verification; counter compare-and-set; grants single-use, 10 min TTL, bound to the issuing User-Agent | adminRecoveryFlow "a challenge is single-use", "a grant is single-use: a replay fails" (DB) |
| Unauthorized passkey registration | `requireRole("ADMIN")` + current-password re-auth (throttled) on every sensitive call; challenge bound to user; `credentialId` unique; max 10 | adminSecurity "requires the current password…", "rejects a challenge issued to a DIFFERENT Admin" (DB) |
| Account enumeration | One error for every verification failure; identical passkey options for any email; throttle keyed by HMAC(email) for known and unknown; admin `/forgot-password` returns the generic reply | adminRecoveryFlow "answers identically for a wrong code, unknown email, Cashier email, suspended Admin and Admin with no methods" (DB) |
| Privilege escalation | Role/status re-checked on the locked row at reset; routes never accept userId/role/shopId; Cashiers get 403 everywhere and cannot be recovered | adminSecurity "rejects a Cashier (403) on every route"; adminRecoveryFlow "a Cashier can never be recovered" (DB) |
| Cross-account recovery | Code hash includes user id; passkey must belong to the emailed account; reset takes **no** email — the account is the grant's | adminRecoveryFlow "another Admin's valid code/passkey never works…", "the account is ALWAYS the grant's" (DB) |
| Recovery-session hijack | 256-bit opaque grant, hash-only storage, `no-store`, UA binding that does not burn the grant on mismatch, sessions revoked on success | adminRecoveryFlow "rejects a grant presented by a different client" (DB) |
| Master password / bypass | None exists. Admin e-mail reset disabled, old tokens rejected. No-method accounts: manual procedure in `ADMIN_OWNERSHIP_RECOVERY.md` | adminRecoveryFlow "an Admin with NO recovery method cannot be reset…", "an emailed reset token (old flow) can no longer be used" (DB) |

## Findings fixed in Phase 5

1. **`trustProxy: true` let any client forge its IP (High).** The IP throttle, the route rate limiter, the audit trail and the "password was reset" e-mail all use `request.ip`; with `true`, Fastify trusts the left-most `X-Forwarded-For` entry, which the client types. Rotating that header defeated every per-IP limit (the per-account throttle still held). Now `TRUST_PROXY` is explicit: default **1 hop in production**, nothing trusted elsewhere, `true` refused. Note: Fastify 5 ignores plain numeric `trustProxy` (fails closed), so hop counts are implemented as a function — verified with real requests (`trustProxy.test.ts`).
2. **No audit trail for manual recovery.** Added `MANUAL_OWNERSHIP_RECOVERY` (migration `20261024000000`); the SQL in the procedure was run against the real schema.

## Residual risks and decisions for you

- **Hop count must match your host.** `1` is right behind one proxy (Railway, a single Nginx). If a CDN sits in front of the platform's load balancer use `2`; set `TRUST_PROXY` to the proxies' CIDRs if the app can also be reached directly. A wrong value fails toward "everyone shares one IP", which can trip the 20/h IP limit for all users — check `ip` in `admin_recovery_audit` after deploying.
- **Targeted throttling.** Anyone can spend an Admin's 5 free attempts and force a 30 s–15 min delay on their recovery (there is deliberately no permanent lockout). Accepted trade-off.
- **Burst race on the throttle.** Parallel requests can all pass the check before any failure is recorded. This only matters if guessing is feasible, which it is not (160-bit codes, signature-bound passkeys); it is bounded further by the route limiter.
- **Other recovery codes survive a code-based reset.** Left alone so the Admin keeps a lifeline; if you'd rather revoke the remaining codes (forcing regeneration) after any successful recovery, say so.
- **Audit rows are never purged** (Phase 4 decision still open).
