# prisma/prepared — NOT migrations. Do not apply automatically.

These scripts are deliberately outside `prisma/migrations/` so `prisma migrate deploy` can never run them.
Each one starts with a read-only pre-flight inside the same transaction and ABORTS (raises) if the
data it would constrain is not clean. Run order and approval are described in
`docs/PHASE2_STAGE_2_1_MIGRATION_PLAN.md`. Rehearse on a restored copy first; never on production
without separate written authorization.

| File | Purpose | Applies only when |
|---|---|---|
| `01_global_barcode_unique.sql` | One barcode = one product across all branches (case/space-insensitive) | Q1 section 9b (exact and normalized) shows zero duplicates, or the Q4 manual decision has resolved them |
| `02_one_cashier_per_branch.sql` | At most one ACTIVE/PENDING_ADMIN_APPROVAL Cashier per branch | Q1 section 3a (ACTIVE + PENDING variant) is empty, or the owner has resolved each conflict |
| `03a_inventory_cutover_verify_readonly.sql` | Read-only: would the BranchInventory backfill pass? Ends with a `READY`/`BLOCKED` verdict | Any time (rehearsal, and just before the freeze) |
| `03_inventory_cutover.sql` | **Writes.** Transactional BranchInventory backfill + switch to `BRANCH`; hard-stops on any mismatch | Only with separate written authorization, after backup, rehearsal and billing freeze — see `docs/PHASE2_STAGE_2_3_CUTOVER_RUNBOOK.md` |
| `03b_inventory_cutover_rollback.sql` | **Writes.** Reverts the cutover if (and only if) no stock moved since | Only with authorization |
| `03c_inventory_invariants_readonly.sql` | Read-only post-cutover invariant check | Any time after cutover |
