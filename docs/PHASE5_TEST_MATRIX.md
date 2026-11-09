# Cashier Recovery — Phase 5 test matrix

**Run it (local TEST database only — the script refuses anything else):**
```
bash scripts/phase5-verify.sh        # generate → migrate deploy (test DB) → tsc → full vitest suite
```
It writes `phase5-results.txt`. Nothing here has been executed yet; the "Status" column is filled in from that file.

Test files: **A** = `test/cashierRecovery.integration.test.ts` (Phase 2) · **B** = `test/cashierRecoveryPhase5.integration.test.ts` (new)

| # | Required case | Covered by | Status |
|---|---|---|---|
| 1 | Valid Cashier recovery request | A › request › creates a PENDING request with expiresAt exactly createdAt + 15 minutes | ☐ |
| 2 | Unknown account submission | A › request › identical generic response for known, unknown, admin and non-active accounts | ☐ |
| 3 | Central Admin sees all Cashier requests | A › central admin authorization › sees requests from EVERY shop · B › 16/17 | ☐ |
| 4 | Cashier cannot use Admin recovery endpoints | A › a Cashier token is refused; anonymous callers get 401 | ☐ |
| 5 | Unauthenticated user cannot approve | A › same test (`approve("")` → 401, request stays PENDING) | ☐ |
| 6 | Expired request rejected | A › approval › rejects approval of an expired request · redemption › an expired request's code is rejected · B › e2e | ☐ |
| 7 | Rejected request cannot be reused | A › approval › a rejected request cannot be approved or reused; rejecting an approved one revokes its code | ☐ |
| 8 | Valid recovery-code verification | A › redemption › valid code … · accepts the code typed in lowercase / without dashes | ☐ |
| 9 | Invalid code rejected | A › redemption › every failure is the SAME 400 | ☐ |
| 10 | Previously used code rejected | A › a used code is rejected · B › e2e (single use) | ☐ |
| 11 | Concurrent redemption | A › concurrent redemption: exactly one of N parallel attempts wins · concurrent approvals produce a single winner | ☐ |
| 12 | Password reset after verification | A › valid code: password changes, old password dead, new works | ☐ |
| 13 | Existing Cashier sessions revoked | A › valid code … ALL sessions revoked (old token → 401, 0 live sessions) | ☐ |
| 14 | Admin password unchanged | A › valid code … admin untouched (hash identical) | ☐ |
| 15 | Existing Cashier login still works | B › 15/20 › pending/approved request never locks login; other Cashier untouched | ☐ |
| 16 | Recovery across multiple branches | A › recovery works for cashiers of different branches · B › 16/17 | ☐ |
| 17 | Shop switching doesn't affect access | A › sees requests regardless of selected shop · B › 16/17 (switches shops between approvals, incl. a shop the Admin doesn't own) | ☐ |
| 18 | Rate limiting / abuse prevention | A › request › throttles per account (5/h) and per IP (10/h) · redemption › repeated wrong codes → 429 · DB CHECK constraints | ☐ + manual M2 |
| 19 | Recovery audit logging | A › audit logging › request → approval → failure → completion, never a code/hash/password | ☐ |
| 20 | Existing POS regression | Full suite via the script · B › 15/20 (recovered Cashier reaches ordinary APIs) · B › legacy endpoints inert | ☐ |

## Manual checks (cannot be automated in the test DB)
- **M1 — Production config:** `CENTRAL_ADMIN_USER_ID` and `RECOVERY_CODE_PEPPER` set in the host environment (not committed). With either missing, recovery must answer 503 and the Admin tab must show "isn't set up yet".
- **M2 — HTTP rate limiter:** it is switched off under `NODE_ENV=test`. On staging, send 6 requests to `POST /api/auth/cashier-recovery/request` within 10 minutes; the 6th must return 429.
- **M3 — UI click-through (staging, two browsers):** Cashier files a request → Admin → Sessions → Recovery Requests shows it → Approve (tick box + password) → code shown once and hidden by default → Cashier enters code + new password → old tab signed out → login works. Then check: the code is not in the address bar, browser storage, or the network tab of any list call.
- **M4 — Expiry on screen:** the Cashier countdown reaches 0 and swaps to "Submit a new request"; the Admin row flips to Expired and loses its buttons.
- **M5 — Migrations:** run both migrations on a staging copy of production first; confirm `cashier_recovery_requests` is empty and existing tables are unchanged. No production migration without your approval.

## Already verified (Phases 3–4, in my sandbox)
- Admin app: type-check and production build pass; Recovery Requests tab, approve modal and one-time code modal compile cleanly.
- Cashier app: 9 UI tests pass (generic notice, successful reset, secrets only in the POST body, never in URL or storage, weak/mismatched password blocked locally, single generic failure message, 15-minute expiry swap, "I have a code" path, old reset link redirect).
