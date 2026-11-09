# Cashier Forgot Password — admin-assisted recovery (backend)

No email, OTP or reset link is used. The Cashier files a request; the **one Central Admin** verifies them
**in person**, re-enters their own password, and receives a one-time code which they hand over directly.

## Flow
1. `POST /api/auth/cashier-recovery/request {email}` — always the same generic 200 (unknown / admin / suspended
   accounts are indistinguishable). Creates a `PENDING` request, `expiresAt = createdAt + 15 min` (DB CHECK).
2. Central Admin: `GET /api/admin/cashier-recovery?filter=active|history|all` (all shops, never shop-scoped).
3. Central Admin: `POST /api/admin/cashier-recovery/:id/approve {currentPassword, identityVerified:true}` →
   `{code, expiresAt}` shown **once**. Only an HMAC of the code is stored. Approval never changes `expiresAt`.
   `POST /api/admin/cashier-recovery/:id/reject` rejects a pending request or revokes an approved one.
4. `POST /api/auth/cashier-recovery/reset {email, code, newPassword}` — one transaction: claim the request
   (single-use), write the new bcrypt hash, revoke **all** of the cashier's sessions. Every failure is the same 400.

No token or grant is ever issued to the Cashier, so nothing from this flow can be replayed against POS APIs.

## Required production configuration (nothing is applied automatically)
| Variable | Purpose |
|---|---|
| `CENTRAL_ADMIN_USER_ID` | `users.id` (UUID) of the Central Admin. **Unset ⇒ recovery fails closed (503).** Never inferred. |
| `RECOVERY_CODE_PEPPER` | ≥32-char random secret keying the code hash (`openssl rand -base64 48`). Shared with Admin recovery. Rotating it invalidates outstanding codes (they live ≤15 min). |

Find the id with `docs/central-admin-audit.sql` (read-only), then set it in the host's environment variables
(Railway/Render). Do not commit either value.

## Migrations (additive; not yet run anywhere but a local scratch DB)
1. `20261025000000_cashier_recovery_audit_actions` — `ALTER TYPE "AuditAction" ADD VALUE` ×7.
2. `20261025000100_cashier_recovery_requests` — enum, empty table, indexes, **partial unique index**
   (one active request per cashier), CHECK constraints, FKs, RLS on + anon/authenticated revoked.
Rollback: `DROP TABLE cashier_recovery_requests; DROP TYPE "CashierRecoveryStatus";` (enum values on
`AuditAction` cannot be removed in Postgres and are harmless).

## Security changes bundled with this phase
* `POST /api/auth/admin/signup` is now authenticated and can no longer create Admin accounts or link an
  admin to a shop another admin manages.
* `POST /api/auth/forgot-password` / `reset-password` are disabled for all roles (no email is sent, no token accepted).
  The Admin recovery implementation (`routes/adminRecovery.ts`, `lib/adminRecovery.ts`, …) is unchanged.
