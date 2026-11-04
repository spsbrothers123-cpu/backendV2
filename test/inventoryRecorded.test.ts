/**
 * Stage 3.3 — getRecordedProductIds(): "does a BranchInventory ROW exist?"
 *
 * Pure unit test (no database): a tiny in-memory stand-in for
 * `db.branchInventory.findMany` that honours `where` and `select`, so the test
 * proves the helper decides from row EXISTENCE and never from the quantity.
 */
import { describe, expect, it, vi } from "vitest";
import { getRecordedProductIds } from "../src/services/inventoryService.js";

interface Row {
  shopId: string;
  productId: string;
  quantity: number;
}

function fakeDb(rows: Row[]) {
  const findMany = vi.fn(async (args: { where: { shopId: string; productId: { in: string[] } }; select?: Record<string, boolean> }) => {
    const hit = rows.filter((r) => r.shopId === args.where.shopId && args.where.productId.in.includes(r.productId));
    // Honour `select`: only the selected columns come back, like Prisma.
    return hit.map((r) => (args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, (r as never)[k]])) : r));
  });
  return { db: { branchInventory: { findMany } } as never, findMany };
}

describe("getRecordedProductIds (Stage 3.3 inventoryRecorded)", () => {
  it("is true for a row holding a genuine zero and for a stocked row; false when no row exists", async () => {
    const { db } = fakeDb([
      { shopId: "A", productId: "zero", quantity: 0 },
      { shopId: "A", productId: "stocked", quantity: 12 },
    ]);
    const recorded = await getRecordedProductIds(db, "A", ["zero", "stocked", "missing"]);
    expect(recorded.has("zero")).toBe(true);
    expect(recorded.has("stocked")).toBe(true);
    expect(recorded.has("missing")).toBe(false);
  });

  it("never reads the quantity (existence only)", async () => {
    const { db, findMany } = fakeDb([{ shopId: "A", productId: "p", quantity: 0 }]);
    await getRecordedProductIds(db, "A", ["p"]);
    const arg = findMany.mock.calls[0][0];
    expect(arg.select).toEqual({ productId: true });
  });

  it("is scoped to the branch: another branch's row does not count", async () => {
    const { db } = fakeDb([{ shopId: "B", productId: "p", quantity: 5 }]);
    expect((await getRecordedProductIds(db, "A", ["p"])).has("p")).toBe(false);
    expect((await getRecordedProductIds(db, "B", ["p"])).has("p")).toBe(true);
  });

  it("does not query at all for an empty page", async () => {
    const { db, findMany } = fakeDb([]);
    expect((await getRecordedProductIds(db, "A", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
