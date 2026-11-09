# Phase 2 · Stage 2.1 — Migration plan & rollback

Status: **prepared, not applied anywhere**. No production access was used.

## 1. What ships in Stage 2.1

| Artifact | Applied by `prisma migrate deploy`? | Purpose |
|---|---|---|
| `prisma/migrations/20261026000000_phase2_branch_product_inventory/migration.sql` | Yes (when you approve) | Creates **empty** `branch_products` and `branch_inventories` |
| `prisma/schema.prisma` | n/a | `BranchProduct`, `BranchInventory` models + back-relations on `Shop`/`Product` |
| `prisma/prepared/01_global_barcode_unique.sql` | **No** (outside migrations) | Global barcode uniqueness, gated by pre-flight |
| `prisma/prepared/02_one_cashier_per_branch.sql` | **No** (outside migrations) | One ACTIVE/PENDING Cashier per branch, gated by pre-flight |
| `docs/PHASE2_STAGE_2_1_ROLLBACK.sql` | Manual | Drops the two new tables (refuses if they hold rows) |

No application code reads or writes the new tables in this stage. Behaviour of the running system is unchanged.

## 2. Apply procedure (when authorized — staging/restored copy first)

1. Verified backup (`pg_dump -Fc`) and note its checksum.
2. `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` → expect no difference except the two CHECK constraints (Prisma ignores CHECKs). Investigate anything else.
3. Apply to the **restored copy** with `npx prisma migrate deploy`.
4. Verify: `SELECT count(*)` on both new tables = 0; row counts and fingerprints of all existing tables unchanged.
5. Only then, with separate written approval, repeat on production. No billing freeze is needed for 2.1 (empty tables, no locks on hot tables beyond brief FK catalog locks on `shops`/`products`).

## 3. Gated constraints (apply **only** after data is clean and you approve)

- **Global barcode** — prerequisite: Q1 section 9b clean, *including* the normalized variant (`lower(btrim(barcode))`), or the approved Q4 manual decision has resolved each conflict. The script re-checks inside its own transaction and aborts without creating anything if conflicts remain. The existing per-shop unique stays.
- **One Cashier per branch** — prerequisite: Q1 section 3a (ACTIVE **and** PENDING_ADMIN_APPROVAL) is empty, i.e. the owner has chosen which Cashier stays per conflicting branch. The script aborts if any branch still has two. Nothing is auto-resolved, deleted or transferred. Suspending the surplus Cashier (history preserved) is a Stage 2.4 owner action, not part of this script.

## 4. Rollback

| Situation | Action |
|---|---|
| Migration applied, new tables unused/empty | Run `docs/PHASE2_STAGE_2_1_ROLLBACK.sql` (guard refuses if rows exist), then `prisma migrate resolve --rolled-back 20261026000000_phase2_branch_product_inventory`, and revert the schema/migration commit. |
| A gated index was applied | `DROP INDEX IF EXISTS "products_barcode_global_unique_idx";` / `DROP INDEX IF EXISTS "users_one_open_cashier_per_shop_idx";` |
| Any later stage wrote data to the new tables | Not this script. Use the stage-specific, rehearsed procedure (verified-backup restore). |

## 5. Existing-data guarantees

Nothing is read, copied or modified: `products` (IDs, `shopId`, `stock`), `cashier_inventories`, `inventory_movements`, bills, purchases, customers and credits are untouched. Verified on a scratch Postgres 16 by fingerprinting every existing table before and after (identical).
