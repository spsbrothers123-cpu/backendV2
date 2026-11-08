# Phase 2 · Stage 2.3 — Branch Inventory cutover runbook

Status: **prepared, not executed anywhere.** Nothing here may run against production without separate written authorization.

## What changes at cutover

| | Before (`inventory_source = CASHIER`) | After (`BRANCH`) |
|---|---|---|
| Stock source | `cashier_inventories` (per Cashier) | `branch_inventories` (per branch + product) |
| `Product.stock` | maintained aggregate | maintained aggregate = SUM over branches |
| `cashier_inventories` | written | **frozen, read-only legacy** |
| Cashier on a movement | stock owner | actor metadata only |
| Admin stock endpoints | cashier required | cashier optional |

The new code ships **before** the cutover and behaves like Stage 2.2 until the flag flips (the only difference: Admin screens already show each *branch's* stock).

## Order of operations

1. **Deploy migrations (additive, safe):** `20261026…` (2.1 tables), `20261027000000`/`…000100` (2.2), `20261028000000_phase2_system_flags` (flag = `CASHIER`).
2. **Deploy the Stage 2.3 code.** Behaviour is unchanged until step 8.
3. **Verified backup:** `pg_dump -Fc`, record checksum, test-restore it.
4. **Rehearsal on the restored copy:** run `03a` (expect `READY`), `03_inventory_cutover.sql`, `03c`, exercise sale/purchase/adjustment, then `03b` rollback. Fix nothing silently — any `BLOCKED`/`HARD STOP` goes back to the owner.
5. **Authorization** for the production window.
6. **Billing freeze** (operational): no sales, purchases or adjustments. The script also freezes at DB level, but the operational freeze keeps customers out of failed requests.
7. `03a_inventory_cutover_verify_readonly.sql` on production → must say `READY: all invariants hold`.
8. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/prepared/03_inventory_cutover.sql` (one transaction; any failure rolls everything back).
9. `03c_inventory_invariants_readonly.sql` → only the flag row; then one test sale + one adjustment per branch; re-run `03c`.
10. Lift the freeze.

## Hard stops (the script aborts, changes nothing)

`Product.stock ≠ SUM(CashierInventory)` for any product · any negative quantity · `branch_inventories` not empty · flag missing or already `BRANCH` · any post-backfill mismatch (per row, per product, grand total).

## Rollback

* **Failed cutover:** automatic (transaction).
* **After cutover, before any stock moved:** `03b_inventory_cutover_rollback.sql` (flag back to `CASHIER`, derived rows removed). It **refuses** if any movement was recorded after the cutover.
* **After stock moved:** restore the verified backup, or an owner-approved reconciliation. No silent copy-back.

## Locking (why this is safe against in-flight sales)

Every stock transaction takes `FOR SHARE` on the `inventory_source` row; the cutover takes it `FOR UPDATE` **first**, then table locks (this order avoids a deadlock). It therefore waits for in-flight stock transactions and blocks new ones until it commits. Verified by an automated test.
