/**
 * Backend Phase 3 — notification engine, DATABASE-BACKED.
 *
 * Runs ONLY against a disposable local Postgres whose name contains "test"
 * (enforced by test/setup.ts):
 *
 *   RUN_INTEGRATION_TESTS=1 npx vitest run test/notifications.integration.test.ts
 *
 * Sweepers are invoked directly with an injected `now`, so time-dependent
 * behaviour (IST schedules, catch-up, retention) is deterministic.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/password.js";
import { resetDb } from "./dbReset.js";
import { createAdminFixture } from "./adminFixture.js";
import { createAssignedProduct, seedStock } from "./branchFixtures.js";
import { createAnnouncement } from "../src/notifications/announcements.js";
import { createNotification } from "../src/notifications/service.js";
import { acquireJob, releaseJob } from "../src/notifications/jobState.js";
import { runJobOnce } from "../src/notifications/scheduler.js";
import { inventorySweep } from "../src/notifications/sweepers/inventory.js";
import { billSweep } from "../src/notifications/sweepers/bills.js";
import { sessionClosedSweep } from "../src/notifications/sweepers/sessions.js";
import { securitySweep } from "../src/notifications/sweepers/security.js";
import { dailySummarySweep } from "../src/notifications/sweepers/dailySummary.js";
import { reminderSweep } from "../src/notifications/sweepers/reminders.js";
import { retentionSweep } from "../src/notifications/sweepers/retention.js";
import { creditOverdueSweep } from "../src/notifications/sweepers/credit.js";
import { announcementDeliverySweep } from "../src/notifications/sweepers/announcements.js";

const enabled = !!process.env.RUN_INTEGRATION_TESTS;
const envMut = env as unknown as { CENTRAL_ADMIN_USER_ID?: string };

let app: FastifyInstance;
beforeAll(async () => {
  if (!enabled) return;
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  if (!enabled) return;
  await app.close();
  await prisma.$disconnect();
});

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
const json = (r: { payload: string }) => JSON.parse(r.payload);
const T0 = new Date(Date.now() - 60_000);
const ctx = (now = new Date()) => ({ now, since: T0 });

async function makeCashier(shopId: string, email: string) {
  const u = await prisma.user.create({ data: { name: email.split("@")[0], email, passwordHash: await hashPassword("Password123"), role: "CASHIER", status: "ACTIVE", shopId } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "Password123" } });
  return { user: u, token: json(res).token as string };
}

let central: Awaited<ReturnType<typeof createAdminFixture>>;
let other: Awaited<ReturnType<typeof createAdminFixture>>;
let shopB: { id: string; name: string };
let cashA: Awaited<ReturnType<typeof makeCashier>>;
let cashB: Awaited<ReturnType<typeof makeCashier>>;

beforeEach(async () => {
  if (!enabled) return;
  await resetDb();
  await prisma.systemFlag.upsert({ where: { key: "inventory_source" }, update: { value: "BRANCH" }, create: { key: "inventory_source", value: "BRANCH" } });
  central = await createAdminFixture(app, { email: "central@rbr.test", shopLocation: "Veerapandi" });
  envMut.CENTRAL_ADMIN_USER_ID = central.user.id;
  other = await createAdminFixture(app, { email: "other@rbr.test", shopLocation: "Palladam" });
  shopB = { id: other.shop.id, name: other.shop.name };
  cashA = await makeCashier(central.shop.id, "cashA@rbr.test");
  cashB = await makeCashier(shopB.id, "cashB@rbr.test");
});

async function lowStockProduct(shopId: string, qty: number, threshold = 10) {
  const p = await createAssignedProduct({ shopId, name: "Egg Tray", category: "Eggs", sellingPrice: 100, stock: 0, unit: "TRAY", lowStockThreshold: threshold });
  await seedStock(shopId, shopId === central.shop.id ? cashA.user.id : cashB.user.id, p.id, qty);
  return p;
}

describe.skipIf(!enabled)("generation, idempotency, targeting", () => {
  it("one stock transition → ONE Admin + ONE branch-Cashier notification; reruns add nothing", async () => {
    await lowStockProduct(central.shop.id, 4);
    await inventorySweep.run(ctx());
    await inventorySweep.run(ctx());
    await inventorySweep.run(ctx());
    expect(await prisma.appNotification.count({ where: { type: "inventory.low_stock" } })).toBe(2); // admin + cashier rows
    const admin = json(await call("GET", "/api/admin/notifications", central.token));
    expect(admin.items).toHaveLength(1);
    expect(admin.items[0]).toMatchObject({ category: "inventory", type: "inventory.low_stock", read: false, branch: { id: central.shop.id } });
    expect(admin.unreadCount).toBe(1);
    const c = json(await call("GET", "/api/notifications", cashA.token));
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ type: "low_stock", shopId: central.shop.id, recipientCashierId: cashA.user.id });
  });

  it("branch isolation: the other branch's Cashier and the other ADMIN see nothing", async () => {
    await lowStockProduct(central.shop.id, 4);
    await inventorySweep.run(ctx());
    expect(json(await call("GET", "/api/notifications", cashB.token)).items).toHaveLength(0);
    expect((await call("GET", "/api/admin/notifications", other.token)).statusCode).toBe(403);
    const adminRow = await prisma.appNotification.findFirstOrThrow({ where: { dedupeKey: { contains: "|ADMIN|" } } });
    expect((await call("GET", `/api/notifications/${adminRow.id}`, cashA.token)).statusCode).toBe(404); // admin row is not the cashier's
    expect((await call("GET", `/api/notifications/${adminRow.id}`, cashB.token)).statusCode).toBe(404);
  });

  it("Central Admin sees every branch regardless of the selected shop", async () => {
    await lowStockProduct(central.shop.id, 4);
    await lowStockProduct(shopB.id, 0);
    await inventorySweep.run(ctx());
    const res = json(await call("GET", "/api/admin/notifications", central.token));
    expect(new Set(res.items.map((i: any) => i.branch.id))).toEqual(new Set([central.shop.id, shopB.id]));
    await call("POST", "/api/admin/shops/switch", central.token, { shopId: shopB.id });
    expect(json(await call("GET", "/api/admin/notifications", central.token)).total).toBe(2);
  });

  it("restock → restocked; recovering again does not repeat the low alert for the same transition", async () => {
    const p = await lowStockProduct(central.shop.id, 4);
    await inventorySweep.run(ctx());
    await prisma.branchInventory.update({ where: { shopId_productId: { shopId: central.shop.id, productId: p.id } }, data: { quantity: 50 } });
    await inventorySweep.run(ctx());
    await inventorySweep.run(ctx());
    expect(await prisma.appNotification.count({ where: { type: "inventory.restocked", dedupeKey: { contains: "|ADMIN|" } } })).toBe(1);
  });

  it("branch low-stock override beats Product.lowStockThreshold (D-17)", async () => {
    const p = await lowStockProduct(central.shop.id, 15, 10); // 15 > 10 → OK at global level
    await prisma.branchProductLowStock.create({ data: { shopId: central.shop.id, productId: p.id, lowStockThreshold: 20 } });
    await inventorySweep.run(ctx());
    expect(await prisma.appNotification.count({ where: { type: "inventory.low_stock" } })).toBe(2);
  });

  it("disabling a category stops generation for that user; Security cannot be disabled", async () => {
    expect((await call("PATCH", "/api/notifications/settings", cashA.token, { categories: { inventory: false } })).statusCode).toBe(200);
    await lowStockProduct(central.shop.id, 4);
    await inventorySweep.run(ctx());
    expect(json(await call("GET", "/api/notifications", cashA.token)).items).toHaveLength(0);
    expect((await call("PATCH", "/api/notifications/settings", cashA.token, { categories: { account_security: false } })).statusCode).toBe(403);
    await expect(prisma.notificationPreference.create({ data: { userId: cashA.user.id, category: "ACCOUNT_SECURITY", enabled: false } })).rejects.toThrow(); // DB CHECK
  });
});

describe.skipIf(!enabled)("D-19 thresholds on bills and sessions", () => {
  async function bill(shopId: string, cashierId: string, total: number, creditPart = 0) {
    const b = await prisma.bill.create({
      data: { shopId, cashierId, status: "PAID", subtotal: total, grandTotal: total, paidAt: new Date(), billNumber: `T-${Math.random().toString(36).slice(2, 8)}` } as never,
    });
    if (creditPart > 0) await prisma.payment.create({ data: { billId: b.id, method: "CREDIT", amount: creditPart } as never });
    if (total - creditPart > 0) await prisma.payment.create({ data: { billId: b.id, method: "CASH", amount: total - creditPart } as never });
    return b;
  }
  it("₹4,999.99 no; ₹5,000 yes (inclusive); one notification per bill even across reruns", async () => {
    await bill(central.shop.id, cashA.user.id, 4999.99);
    const b2 = await bill(central.shop.id, cashA.user.id, 5000);
    await billSweep.run(ctx());
    await billSweep.run(ctx());
    const rows = await prisma.appNotification.findMany({ where: { type: "sales.high_value" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].targetId).toBe(b2.id);
  });
  it("large credit uses the CREDIT portion, >= ₹10,000", async () => {
    await bill(central.shop.id, cashA.user.id, 12000, 9999.99);
    await bill(central.shop.id, cashA.user.id, 12000, 10000);
    await billSweep.run(ctx());
    expect(await prisma.appNotification.count({ where: { type: "credit.large_sale" } })).toBe(1);
  });
  it("Cashiers never receive transaction alerts", async () => {
    await bill(central.shop.id, cashA.user.id, 20000, 15000);
    await billSweep.run(ctx());
    expect(json(await call("GET", "/api/notifications", cashA.token)).items).toHaveLength(0);
  });
  it("branch override of the high-value threshold is honoured", async () => {
    await prisma.branchNotificationSettings.create({ data: { shopId: central.shop.id, highValueSaleThreshold: 1000 } });
    await bill(central.shop.id, cashA.user.id, 1000);
    await billSweep.run(ctx());
    expect(await prisma.appNotification.count({ where: { type: "sales.high_value" } })).toBe(1);
  });
  it("ANY non-zero cash difference raises a mismatch; exact cash does not", async () => {
    const mk = async (cashier: typeof cashA, actual: number) =>
      prisma.cashierSession.create({ data: { shopId: cashier.user.shopId!, cashierId: cashier.user.id, openingCash: 1000, status: "CLOSED", closedAt: new Date(), actualClosingCash: actual } as never });
    await mk(cashA, 1000);
    await mk(cashB, 999.99);
    await sessionClosedSweep.run(ctx());
    const m = await prisma.appNotification.findMany({ where: { type: "cash.mismatch" } });
    expect(m.every((r) => r.shopId === shopB.id)).toBe(true);
    expect(m).toHaveLength(2); // admin + cashier B
  });
});

describe.skipIf(!enabled)("customer ownership (D-14)", () => {
  it("overdue credit goes to the owning Cashier only; admin-created customers notify no Cashier", async () => {
    const old = new Date(Date.now() - 45 * 86_400_000);
    const owned = await prisma.customer.create({ data: { shopId: central.shop.id, name: "Owned", phone: "9000000001", cashierId: cashA.user.id, creditBalance: 500 } as never });
    const unowned = await prisma.customer.create({ data: { shopId: central.shop.id, name: "Unowned", phone: "9000000002", creditBalance: 700 } as never });
    for (const c of [owned, unowned]) {
      await prisma.creditTransaction.create({ data: { shopId: central.shop.id, customerId: c.id, type: "CHARGE", amount: Number(c.creditBalance), createdAt: old } as never });
    }
    await creditOverdueSweep.run(ctx());
    const cashier = json(await call("GET", "/api/notifications?category=credit", cashA.token));
    expect(cashier.items).toHaveLength(1);
    expect(cashier.items[0].title).toContain("Owned");
    expect(json(await call("GET", "/api/notifications", cashB.token)).items).toHaveLength(0);
    expect(json(await call("GET", "/api/admin/notifications?category=credit", central.token)).total).toBe(2);
    await creditOverdueSweep.run(ctx());
    expect(await prisma.appNotification.count({ where: { type: "credit.overdue" } })).toBe(3); // 2 admin + 1 cashier, no duplicates
  });
});

describe.skipIf(!enabled)("read / acknowledge / delete rules (D-07..D-11)", () => {
  async function announce(requiresAck: boolean) {
    const a = await createAnnouncement({ adminId: central.user.id, title: "Rate change", body: "Please read.", audience: "ALL_CASHIERS", requiresAcknowledgement: requiresAck });
    const n = await prisma.appNotification.findFirstOrThrow({ where: { announcementId: a.id } });
    return { a, n };
  }
  it("read and acknowledge are independent; repeat acknowledge keeps the ORIGINAL timestamp", async () => {
    const { n } = await announce(true);
    const r1 = json(await call("PUT", `/api/notifications/${n.id}/read-state`, cashA.token, { read: true }));
    expect(r1.notification.readAt).toBeTruthy();
    expect(r1.notification.announcement.acknowledgedAt).toBeNull(); // reading ≠ acknowledging
    const a1 = json(await call("POST", `/api/notifications/${n.id}/acknowledge`, cashA.token, {}));
    const a2 = json(await call("POST", `/api/notifications/${n.id}/acknowledge`, cashA.token, {}));
    expect(a2.notification.announcement.acknowledgedAt).toBe(a1.notification.announcement.acknowledgedAt);
    const un = json(await call("PUT", `/api/notifications/${n.id}/read-state`, cashA.token, { read: false }));
    expect(un.notification.readAt).toBeNull();
    expect(un.notification.announcement.acknowledgedAt).toBe(a1.notification.announcement.acknowledgedAt); // un-read keeps ack
  });
  it("acknowledging does not mark read; non-ack notifications return 409", async () => {
    const { n } = await announce(true);
    const ack = json(await call("POST", `/api/notifications/${n.id}/acknowledge`, cashA.token, {}));
    expect(ack.notification.readAt).toBeNull();
    const { n: plain } = await announce(false);
    const res = await call("POST", `/api/notifications/${plain.id}/acknowledge`, cashA.token, {});
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe("ACKNOWLEDGEMENT_NOT_REQUIRED");
  });
  it("a pending-acknowledgement announcement can't be deleted until acknowledged; then it can", async () => {
    const { n } = await announce(true);
    const item = json(await call("GET", `/api/notifications/${n.id}`, cashA.token));
    expect(item.capabilities.canDelete).toBe(false);
    const denied = await call("DELETE", `/api/notifications/${n.id}`, cashA.token);
    expect(denied.statusCode).toBe(403);
    expect(json(denied).code).toBe("NOTIFICATION_NOT_DELETABLE");
    await call("POST", `/api/notifications/${n.id}/acknowledge`, cashA.token, {});
    expect((await call("DELETE", `/api/notifications/${n.id}`, cashA.token)).statusCode).toBe(200);
    expect((await call("DELETE", `/api/notifications/${n.id}`, cashA.token)).statusCode).toBe(404); // repeat → gone
  });
  it("Security notifications are protected for both audiences (and survive clear-read)", async () => {
    await prisma.cashierRecoveryRequest.deleteMany();
    await createNotification({ audience: "ADMIN", type: "security.failed_login", dedupeKey: "x1", title: "t", message: "m", recipientUserIds: [central.user.id] });
    await createNotification({ audience: "CASHIER", type: "account.password_changed", dedupeKey: "x2", title: "t", message: "m", recipientUserIds: [cashA.user.id] });
    const adminRow = (json(await call("GET", "/api/admin/notifications?category=security", central.token))).items[0];
    expect((await call("DELETE", `/api/admin/notifications/${adminRow.id}`, central.token)).statusCode).toBe(403);
    await call("PATCH", `/api/admin/notifications/${adminRow.id}/read`, central.token, { read: true });
    expect(json(await call("POST", "/api/admin/notifications/clear-read", central.token)).deletedCount).toBe(0);
    const cRow = json(await call("GET", "/api/notifications", cashA.token)).items[0];
    expect(cRow.capabilities.canDelete).toBe(false);
    expect((await call("DELETE", `/api/notifications/${cRow.id}`, cashA.token)).statusCode).toBe(403);
  });
  it("deleted notifications never return; deletion marker lives until expiry then retention purges it", async () => {
    await createNotification({ audience: "CASHIER", type: "inventory.low_stock", dedupeKey: "d1", title: "t", message: "m", recipientUserIds: [cashA.user.id] });
    const id = json(await call("GET", "/api/notifications", cashA.token)).items[0].id;
    await call("DELETE", `/api/notifications/${id}`, cashA.token);
    await createNotification({ audience: "CASHIER", type: "inventory.low_stock", dedupeKey: "d1", title: "t", message: "m", recipientUserIds: [cashA.user.id] }); // regeneration attempt
    expect(json(await call("GET", "/api/notifications", cashA.token)).items).toHaveLength(0);
    expect(await prisma.appNotificationRecipient.count({ where: { notificationId: id, deletedAt: { not: null } } })).toBe(1);
    await retentionSweep.run({ ...ctx(new Date(Date.now() + 89 * 86_400_000)) });
    expect(await prisma.appNotification.count({ where: { id } })).toBe(1); // marker retained until original expiry
    await retentionSweep.run({ ...ctx(new Date(Date.now() + 91 * 86_400_000)) });
    expect(await prisma.appNotification.count({ where: { id } })).toBe(0);
    expect(await prisma.appNotificationRecipient.count({ where: { notificationId: id } })).toBe(0);
  });
  it("a Cashier can't read, delete or acknowledge another Cashier's notification (404)", async () => {
    const { n } = await announce(true);
    await prisma.appNotificationRecipient.deleteMany({ where: { notificationId: n.id, userId: cashB.user.id } });
    for (const [m, u] of [["GET", ""], ["DELETE", ""], ["POST", "/acknowledge"], ["PUT", "/read-state"]] as const) {
      const res = await call(m, `/api/notifications/${n.id}${u}`, cashB.token, m === "PUT" ? { read: true } : m === "POST" ? {} : undefined);
      expect(res.statusCode, `${m}${u}`).toBe(404);
    }
  });
});

describe.skipIf(!enabled)("pagination + IST date filters", () => {
  async function seed(n: number) {
    for (let i = 0; i < n; i++) {
      await createNotification({
        audience: "CASHIER", type: "inventory.low_stock", dedupeKey: `p${i}`, title: `n${i}`, message: "m",
        recipientUserIds: [cashA.user.id], occurredAt: new Date(Date.now() - (n - i) * 60_000),
      });
    }
  }
  it("cursor pagination walks all rows once, newest first, with stable unreadCount", async () => {
    await seed(7);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: any = json(await call("GET", `/api/notifications?limit=3${cursor ? `&cursor=${cursor}` : ""}`, cashA.token));
      expect(r.unreadCount).toBe(7);
      seen.push(...r.items.map((i: any) => i.title));
      cursor = r.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["n6", "n5", "n4", "n3", "n2", "n1", "n0"]);
  });
  it("a cursor from another filter set is 400 INVALID_CURSOR", async () => {
    await seed(4);
    const first = json(await call("GET", "/api/notifications?limit=2", cashA.token));
    const res = await call("GET", `/api/notifications?limit=2&status=unread&cursor=${first.nextCursor}`, cashA.token);
    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe("INVALID_CURSOR");
  });
  it("Admin page/pageSize returns total and unreadCount ignoring filters", async () => {
    for (let i = 0; i < 5; i++) await createNotification({ audience: "ADMIN", type: "inventory.low_stock", dedupeKey: `a${i}`, title: `a${i}`, message: "m", recipientUserIds: [central.user.id] });
    const r = json(await call("GET", "/api/admin/notifications?page=2&pageSize=2&category=inventory", central.token));
    expect(r).toMatchObject({ total: 5, page: 2, pageSize: 2, unreadCount: 5 });
    expect(r.items).toHaveLength(2);
  });
  it("IST day boundaries: an event at 00:10 IST belongs to that IST date, not the previous UTC date", async () => {
    // 2026-11-05 00:10 IST == 2026-11-04 18:40 UTC
    await createNotification({ audience: "ADMIN", type: "inventory.low_stock", dedupeKey: "ist1", title: "late", message: "m", recipientUserIds: [central.user.id], occurredAt: new Date("2026-11-04T18:40:00Z") });
    const on5 = json(await call("GET", "/api/admin/notifications?dateFrom=2026-11-05&dateTo=2026-11-05", central.token));
    const on4 = json(await call("GET", "/api/admin/notifications?dateFrom=2026-11-04&dateTo=2026-11-04", central.token));
    expect(on5.total).toBe(1);
    expect(on4.total).toBe(0);
    await createNotification({ audience: "CASHIER", type: "inventory.low_stock", dedupeKey: "ist2", title: "late", message: "m", recipientUserIds: [cashA.user.id], occurredAt: new Date("2026-11-04T18:40:00Z") });
    expect(json(await call("GET", "/api/notifications?from=2026-11-05&to=2026-11-05", cashA.token)).items).toHaveLength(1);
    expect(json(await call("GET", "/api/notifications?from=2026-11-04&to=2026-11-04", cashA.token)).items).toHaveLength(0);
  });
});

describe.skipIf(!enabled)("scheduler: locking, restart recovery, summaries, reminders", () => {
  it("two instances racing for one job: exactly one holds the lock; a crashed holder's lease expires", async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => acquireJob("race", `inst-${i}`, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await acquireJob("race", "late", new Date(now.getTime() + 60_000))).toBeNull(); // lease valid
    expect(await acquireJob("race", "recover", new Date(now.getTime() + 6 * 60_000))).not.toBeNull(); // expired → takeover
    await releaseJob("race", "inst-0", { success: false, error: "stale", now }); // old owner can't clobber
    expect((await prisma.notificationJobState.findUniqueOrThrow({ where: { key: "race" } })).lockedBy).toBe("recover");
  });
  it("runJobOnce: not_due inside the interval; watermark persists across 'restarts'", async () => {
    const job = { key: "t.job", intervalMs: 60_000, watermarked: true, run: async () => ({ examined: 0, created: 0 }) };
    const t = new Date();
    expect(await runJobOnce(job, "a", t)).toBe("ok");
    expect(await runJobOnce(job, "b", new Date(t.getTime() + 1_000))).toBe("not_due");
    expect(await runJobOnce(job, "b", new Date(t.getTime() + 61_000))).toBe("ok");
    expect((await prisma.notificationJobState.findUniqueOrThrow({ where: { key: "t.job" } })).cursorAt).not.toBeNull();
  });
  it("a failing job records the error and is retried; it never throws", async () => {
    const job = { key: "t.fail", intervalMs: 1_000, watermarked: false, run: async () => { throw new Error("boom"); } };
    const t = new Date();
    expect(await runJobOnce(job, "a", t, { info() {}, error() {} })).toBe("failed");
    const row = await prisma.notificationJobState.findUniqueOrThrow({ where: { key: "t.fail" } });
    expect(row.lastError).toBe("boom");
    expect(row.failureCount).toBe(1);
    expect(row.lockedBy).toBeNull();
  });
  it("daily summary: catch-up after downtime creates MAIN + SUPPLEMENTARY once, with the 12 metrics", async () => {
    const now = new Date("2026-11-07T03:00:00Z"); // 8:30 AM IST on the 7th; the 5th/6th slots were missed
    await dailySummarySweep.run(ctx(now));
    await dailySummarySweep.run(ctx(now));
    const rows = await prisma.dailySummary.findMany({ orderBy: [{ businessDate: "asc" }, { kind: "asc" }] });
    expect(rows.map((r) => `${r.businessDate}:${r.kind}`)).toEqual(expect.arrayContaining(["2026-11-05:MAIN", "2026-11-05:SUPPLEMENTARY", "2026-11-06:MAIN", "2026-11-06:SUPPLEMENTARY"]));
    expect(new Set(rows.map((r) => `${r.businessDate}:${r.kind}`)).size).toBe(rows.length);
    expect((rows[0].metrics as unknown[]).length).toBe(12);
    const api = await call("GET", "/api/admin/daily-summaries/2026-11-05", central.token);
    expect(api.statusCode).toBe(200);
    expect(json(api)).toMatchObject({ id: "2026-11-05", windowStart: "2026-11-04T18:30:00.000Z", windowEnd: "2026-11-05T16:30:00.000Z" });
    expect((await call("GET", "/api/admin/daily-summaries/2026-11-05-supplementary", central.token)).statusCode).toBe(200);
    expect(await prisma.appNotification.count({ where: { type: "summary.daily" } })).toBe(rows.length);
  });
  it("daily summary figures: the 10 PM–12 AM sale lands in the SUPPLEMENTARY summary, not the MAIN one", async () => {
    const lateSale = new Date("2026-11-05T17:00:00Z"); // 10:30 PM IST
    await prisma.bill.create({ data: { shopId: central.shop.id, cashierId: cashA.user.id, status: "PAID", subtotal: 800, grandTotal: 800, paidAt: lateSale, billNumber: "LATE-1" } as never });
    await dailySummarySweep.run(ctx(new Date("2026-11-06T03:00:00Z")));
    const get = async (id: string) => json(await call("GET", `/api/admin/daily-summaries/${id}`, central.token));
    const sales = (s: any) => s.metrics.find((m: any) => m.key === "sales").value;
    expect(sales(await get("2026-11-05"))).toBe(0);
    expect(sales(await get("2026-11-05-supplementary"))).toBe(800);
  });
  it("reminders: IST time per branch, once only, catch-up within grace, none when not needed", async () => {
    await prisma.branchNotificationSettings.create({ data: { shopId: central.shop.id, openingTime: "09:00", closingTime: "21:00" } });
    const before = new Date("2026-11-05T03:29:00Z"); // 8:59 IST
    await reminderSweep.run(ctx(before));
    expect(await prisma.appNotification.count({ where: { type: "reminder.opening" } })).toBe(0);
    const late = new Date("2026-11-05T04:05:00Z"); // restart at 9:35 IST still catches the 9:00 reminder
    await reminderSweep.run(ctx(late));
    await reminderSweep.run(ctx(late));
    expect(await prisma.appNotification.count({ where: { type: "reminder.opening" } })).toBe(1);
    expect(json(await call("GET", "/api/notifications", cashB.token)).items).toHaveLength(0); // other branch: nothing
    // closing reminder only when a session is still open
    await reminderSweep.run(ctx(new Date("2026-11-05T15:35:00Z"))); // 21:05 IST, nothing open
    expect(await prisma.appNotification.count({ where: { type: "reminder.closing" } })).toBe(0);
  });
});

describe.skipIf(!enabled)("security events (D-20) and announcements (D-21)", () => {
  it("5 failed logins in 10 minutes → Central Admin only; 4 → nothing; no duplicate on rerun", async () => {
    const now = new Date();
    for (let i = 0; i < 4; i++) await prisma.auditLog.create({ data: { action: "LOGIN_FAILED", actorRole: "CASHIER", metadata: { email: "four@x.test" }, createdAt: new Date(now.getTime() - i * 60_000) } as never });
    for (let i = 0; i < 5; i++) await prisma.auditLog.create({ data: { action: "LOGIN_FAILED", actorRole: "CASHIER", metadata: { email: "five@x.test" }, createdAt: new Date(now.getTime() - i * 60_000) } as never });
    await securitySweep.run(ctx(now));
    await securitySweep.run(ctx(now));
    const rows = await prisma.appNotification.findMany({ where: { type: "security.failed_login" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("f***@x.test"); // masked
    expect(rows[0].message).not.toContain("five@x.test");
    expect(json(await call("GET", "/api/admin/notifications?category=security", central.token)).total).toBe(1);
    expect((await call("GET", "/api/admin/notifications", other.token)).statusCode).toBe(403);
    expect(json(await call("GET", "/api/notifications", cashA.token)).items).toHaveLength(0);
  });
  it("announcement content is immutable at the DB level; a revision supersedes it", async () => {
    const a = await createAnnouncement({ adminId: central.user.id, title: "T", body: "B", audience: "ALL_CASHIERS", requiresAcknowledgement: true });
    await expect(prisma.announcement.update({ where: { id: a.id }, data: { body: "edited" } })).rejects.toThrow();
    const rev = await call("POST", `/api/admin/announcements/${a.id}/revise`, central.token, { title: "T2", body: "B2", requiresAcknowledgement: true });
    expect(rev.statusCode).toBe(201);
    expect((await prisma.announcement.findUniqueOrThrow({ where: { id: a.id } })).supersededAt).not.toBeNull();
    expect((await call("POST", `/api/admin/announcements/${a.id}/revise`, central.token, { title: "T3", body: "B3" })).statusCode).toBe(409);
  });
  it("ack-required announcements are delivered even if the category is off; late-approved Cashiers get them via top-up", async () => {
    await call("PATCH", "/api/notifications/settings", cashA.token, { categories: { announcement: false } });
    const a = await createAnnouncement({ adminId: central.user.id, title: "Must read", body: "B", audience: "ALL_CASHIERS", requiresAcknowledgement: true });
    expect(json(await call("GET", "/api/notifications?category=announcement", cashA.token)).items).toHaveLength(1);
    const late = await makeCashier(central.shop.id, "late@rbr.test");
    await announcementDeliverySweep.run(ctx());
    await announcementDeliverySweep.run(ctx());
    const items = json(await call("GET", "/api/notifications?category=announcement", late.token)).items;
    expect(items).toHaveLength(1);
    expect(items[0].announcement.id).toBe(a.id);
  });
  it("only the Central Admin can compose; Cashiers and other Admins get 403", async () => {
    const body = { title: "x", body: "y", audience: "all", requiresAcknowledgement: false };
    expect((await call("POST", "/api/admin/announcements", other.token, body)).statusCode).toBe(403);
    expect((await call("POST", "/api/admin/announcements", cashA.token, body)).statusCode).toBe(403);
    expect((await call("POST", "/api/admin/announcements", central.token, body)).statusCode).toBe(201);
  });
  it("legacy notifications table is untouched by the engine", async () => {
    const before = await prisma.notification.count();
    await createNotification({ audience: "ADMIN", type: "inventory.low_stock", dedupeKey: "legacy", title: "t", message: "m", recipientUserIds: [central.user.id] });
    expect(await prisma.notification.count()).toBe(before);
  });
});
