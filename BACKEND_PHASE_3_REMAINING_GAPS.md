# Backend Phase 3 — Remaining Gaps, Assumptions, Deferred Work

## Must do before relying on this
1. **Run the integration suite** (`RUN_INTEGRATION_TESTS=1`) and `prisma migrate deploy` + `migrate diff` on a disposable Postgres. Not possible in my sandbox.
2. Confirm `CENTRAL_ADMIN_USER_ID` is set in production, or every Admin route here returns 503.

## Assumptions I had to make (not in D-01…D-27 — please confirm or correct)
- **"Overdue credit" definition.** D-15 gates due dates, so overdue = oldest still-unpaid charge (FIFO) is older than **30 days** (`creditOverdueDays`, overridable per branch). The 30 is mine.
- **"One notification per bill"** implemented as one per bill **per trigger**: a ₹12,000 bill with ₹10,000+ on credit produces both a high-value and a large-credit Admin alert.
- **Late-night summary id** `YYYY-MM-DD-supplementary` (main stays the bare date per the Admin contract). The Admin frontend must know this id.
- **First sweep after deploy** alerts for products *already* low/out (one-time burst); watermarked sweeps look back only 1 hour on first run (no history flood).
- **Cashier receives** `session_opened/closed` for their own session (listed in the Cashier contract); may feel noisy.

## Not implemented / limited
- **Credit adjustments (D-16):** the schema has no ADJUSTMENT ledger type and no code writes manual adjustments; adding one is a billing change (out of scope). The detector watches ledger CHARGE rows with no bill, so it is inert today.
- **Credit due dates & `credit_due_date_changed` (D-15):** gated subphase, not built.
- **Cashier "credit permission"** (Cashier contract §10): no such concept in the schema; credit alerts depend on customer ownership only.
- **Admin acknowledgement endpoint:** no Admin notification requires acknowledgement; the service supports it, no route exposed.
- **`Idempotency-Key`** on acknowledge is shape-validated only; idempotency comes from database state (repeat returns the original timestamp).
- **Cash mismatch** is evaluated when the sweep sees the closed session; bills cancelled afterwards are not re-evaluated. Same for stored summaries.
- **Failed-login alerts** are keyed by e-mail (the audit row holds nothing else) and show a masked e-mail.
- **Opening reminder** uses type `opening_reminder`, which is not in the Cashier contract's type list — the Cashier frontend must tolerate/display it.
- **Validation errors** use the app's existing 422 `VALIDATION_ERROR`; the Cashier contract says 400.
- **Admin settings PUT** silently keeps Security on (contract: "ignore or reject"); Cashier PATCH rejects with 403 per its contract.
- **Behaviour change:** Admin list is now `{items,total,…}` and non-central ADMINs get 403.
- Latency: scheduler tick 30 s + 60 s sweep interval ⇒ alerts appear within ~90 s (Cashier polls every 60 s, D-13).
- Lease lock uses app-server clocks; large skew between instances could shorten/extend a lease (TTL 5 min).
- Overdue sweep reads one ledger per owing customer hourly — fine now, revisit at scale.
- New branch-settings endpoints have no frontend yet.
- Pre-existing lint error in `test/upiAdminRoutes.test.ts` left alone.

## Deferred
- **B3.8 push (FCM/Capacitor):** deferred by D-25. Seam ready: `src/notifications/delivery.ts` hook after commit + `NOTIFICATION_PUSH_ENABLED` (default false). No device-token table or FCM code exists.
