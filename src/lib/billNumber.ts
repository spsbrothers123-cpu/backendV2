import type { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * Generates the next bill number for a shop as EM-<year>-<6-digit-seq>,
 * e.g. EM-2026-000123. Implemented as a single atomic upsert (INSERT ...
 * ON CONFLICT ... DO UPDATE ... RETURNING) so concurrent checkouts in the
 * same shop/year can never be assigned the same sequence number — no
 * separate read-then-write, no application-level locking needed.
 *
 * Must be called with the same `tx` (transaction client) used to create
 * the Bill row, so the counter increment and the bill creation succeed or
 * roll back together.
 */
export async function nextBillNumber(
  tx: Prisma.TransactionClient | PrismaClient,
  shopId: string
): Promise<string> {
  const year = new Date().getFullYear();

  const rows = await tx.$queryRaw<{ seq: number }[]>`
    INSERT INTO bill_counters (id, "shopId", year, seq)
    VALUES (${randomUUID()}, ${shopId}, ${year}, 1)
    ON CONFLICT ("shopId", year)
    DO UPDATE SET seq = bill_counters.seq + 1
    RETURNING seq;
  `;

  const seq = rows[0]?.seq ?? 1;
  const padded = String(seq).padStart(6, "0");
  return `EM-${year}-${padded}`;
}
