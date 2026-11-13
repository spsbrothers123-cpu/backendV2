/**
 * Phase 3 — route-level tests (no database): authorization, scoping, validation,
 * contract shapes and the locked-Security rules, with the inbox/preferences layer
 * replaced by spies. Real-DB behaviour is covered by notifications.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const h = vi.hoisted(() => ({
  calls: [] as { fn: string; args: unknown[] }[],
  prefs: new Map<string, boolean>(),
}));

vi.mock("../src/config/env.js", () => ({ env: { CENTRAL_ADMIN_USER_ID: "central-1", NOTIFICATION_PUSH_ENABLED: false } }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

const NOTIF = {
  userId: "u",
  readAt: null,
  acknowledgedAt: null,
  createdAt: new Date("2026-11-05T09:00:00Z"),
  notification: {
    id: "n1", category: "INVENTORY", type: "inventory.low_stock", severity: "WARNING", title: "t", message: "m",
    createdAt: new Date("2026-11-05T09:00:00Z"), shopId: "shop-1", shop: { id: "shop-1", name: "Main" },
    targetKind: "product", targetId: "p1", targetRoute: null, announcement: null, announcementId: null,
  },
};

vi.mock("../src/notifications/inbox.js", async () => {
  const actual = await vi.importActual<typeof import("../src/notifications/inbox.js")>("../src/notifications/inbox.js").catch(() => null);
  const rec = (fn: string, ret: unknown) => async (...args: unknown[]) => {
    h.calls.push({ fn, args });
    return typeof ret === "function" ? (ret as () => unknown)() : ret;
  };
  return {
    canDelete: actual?.canDelete ?? (() => true),
    countUnread: rec("countUnread", 3),
    listPage: rec("listPage", () => ({ rows: [{ ...NOTIF, userId: "central-1" }], total: 1, unreadCount: 3 })),
    listCursor: async (...args: unknown[]) => {
      h.calls.push({ fn: "listCursor", args });
      if (args[3] === "BAD") throw Object.assign(new Error("cursor"), { statusCode: 400, code: "INVALID_CURSOR" });
      return { rows: [{ ...NOTIF, userId: "cashier-1" }], nextCursor: null, unreadCount: 3 };
    },
    getOwned: rec("getOwned", () => ({ ...NOTIF, userId: "x" })),
    setReadState: rec("setReadState", () => ({ ...NOTIF, userId: "x", readAt: new Date() })),
    markAllRead: rec("markAllRead", 2),
    clearRead: rec("clearRead", 4),
    deleteOwned: rec("deleteOwned", undefined),
    acknowledge: rec("acknowledge", () => ({ ...NOTIF, userId: "x" })),
  };
});

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    notificationPreference: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        [...h.prefs.entries()].filter(([k]) => k.startsWith(where.userId)).map(([k, enabled]) => ({ category: k.split(":")[1], enabled })),
      upsert: async ({ where, create, update }: any) => {
        h.prefs.set(`${where.userId_category.userId}:${where.userId_category.category}`, (update ?? create).enabled);
        return {};
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import adminNotificationsRoutes from "../src/routes/admin/notifications.js";
import adminNotificationSettingsRoutes from "../src/routes/admin/notificationSettings.js";
import cashierNotificationsRoutes from "../src/routes/notifications.js";
import { AppError } from "../src/lib/errors.js";

async function build(user: { id: string; role: "ADMIN" | "CASHIER"; status?: string } | null): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate("requireRole", (role: string) => async (req: any) => {
    if (!user) throw new AppError(401, "UNAUTHENTICATED", "no");
    if (user.role !== role) throw new AppError(403, "FORBIDDEN", "no");
    req.authUser = { status: "ACTIVE", ...user };
  });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.statusCode).send({ code: err.code, message: err.message });
    if (err instanceof ZodError) return reply.code(422).send({ code: "VALIDATION_ERROR" });
    if (err.code === "INVALID_CURSOR") return reply.code(400).send({ code: "INVALID_CURSOR" });
    return reply.code(500).send({ code: "INTERNAL", message: err.message });
  });
  await app.register(adminNotificationsRoutes, { prefix: "/api/admin/notifications" });
  await app.register(adminNotificationSettingsRoutes, { prefix: "/api/admin/notification-settings" });
  await app.register(cashierNotificationsRoutes, { prefix: "/api/notifications" });
  await app.ready();
  return app;
}

const last = (fn: string) => [...h.calls].reverse().find((c) => c.fn === fn);
beforeEach(() => { h.calls.length = 0; h.prefs.clear(); });

describe("Admin notifications — Central Admin only (D-02)", () => {
  it("central Admin: 200 with the contract shape, page/pageSize and derived read", async () => {
    const app = await build({ id: "central-1", role: "ADMIN" });
    const res = await app.inject({ method: "GET", url: "/api/admin/notifications?page=2&pageSize=10&status=unread&category=inventory&branchId=shop-9&dateFrom=2026-11-01&dateTo=2026-11-05" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 1, page: 2, pageSize: 10, unreadCount: 3 });
    expect(body.items[0]).toMatchObject({
      id: "n1", category: "inventory", type: "inventory.low_stock", severity: "warning", read: false, readAt: null,
      branch: { id: "shop-1", name: "Main" }, target: { kind: "product", id: "p1", route: null },
    });
    const call = last("listPage")!;
    expect(call.args[0]).toBe("central-1"); // recipient = the authenticated user, nothing from the client
    expect(call.args[1]).toMatchObject({ status: "unread", category: "INVENTORY", shopId: "shop-9" }); // branchId is a FILTER
    expect((call.args[1] as any).range.gte.toISOString()).toBe("2026-10-31T18:30:00.000Z"); // IST
    expect(call.args[2]).toBe(2);
    expect(call.args[3]).toBe(10);
  });

  it("another ADMIN account cannot see central notifications (403), and a CASHIER can't use admin routes", async () => {
    const other = await build({ id: "admin-2", role: "ADMIN" });
    for (const url of ["/api/admin/notifications", "/api/admin/notifications/unread-count", "/api/admin/notifications/n1", "/api/admin/notification-settings"]) {
      const res = await other.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe("CENTRAL_ADMIN_REQUIRED");
    }
    expect(h.calls).toHaveLength(0);
    const cashier = await build({ id: "cashier-1", role: "CASHIER" });
    expect((await cashier.inject({ method: "GET", url: "/api/admin/notifications" })).statusCode).toBe(403);
  });

  it("a client-supplied userId/adminId/shopId can never change the recipient", async () => {
    const app = await build({ id: "central-1", role: "ADMIN" });
    await app.inject({ method: "GET", url: "/api/admin/notifications?userId=victim&adminId=victim&shopId=x" });
    expect(last("listPage")!.args[0]).toBe("central-1");
    await app.inject({ method: "GET", url: "/api/admin/notifications/n1?userId=victim" });
    expect(last("getOwned")!.args[0]).toBe("central-1");
  });

  it("validates input: bad dates, reversed range, bad page size", async () => {
    const app = await build({ id: "central-1", role: "ADMIN" });
    expect((await app.inject({ method: "GET", url: "/api/admin/notifications?dateFrom=2026-02-31" })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/admin/notifications?dateFrom=2026-11-05&dateTo=2026-11-01" })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/admin/notifications?pageSize=1000" })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/admin/notifications?status=bogus" })).statusCode).toBe(422);
  });

  it("unknown category is tolerated (empty page, real unreadCount)", async () => {
    const app = await build({ id: "central-1", role: "ADMIN" });
    const res = await app.inject({ method: "GET", url: "/api/admin/notifications?category=future_thing" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], total: 0, unreadCount: 3 });
  });

  it("unread-count, detail, read / unread, read-all, delete, clear-read use the contract verbs & statuses", async () => {
    const app = await build({ id: "central-1", role: "ADMIN" });
    expect((await app.inject({ method: "GET", url: "/api/admin/notifications/unread-count" })).json()).toEqual({ unreadCount: 3 });
    expect((await app.inject({ method: "GET", url: "/api/admin/notifications/n1" })).json().id).toBe("n1");
    const read = await app.inject({ method: "PATCH", url: "/api/admin/notifications/n1/read", payload: { read: true } });
    expect(read.statusCode).toBe(204);
    expect(last("setReadState")!.args.slice(0, 3)).toEqual(["central-1", "n1", true]);
    await app.inject({ method: "PATCH", url: "/api/admin/notifications/n1/read", payload: { read: false } });
    expect(last("setReadState")!.args[2]).toBe(false);
    expect((await app.inject({ method: "PATCH", url: "/api/admin/notifications/read-all" })).statusCode).toBe(204);
    expect(last("markAllRead")!.args[0]).toBe("central-1");
    expect((await app.inject({ method: "DELETE", url: "/api/admin/notifications/n1" })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/api/admin/notifications/clear-read" })).json()).toEqual({ deletedCount: 4 });
    expect((await app.inject({ method: "PATCH", url: "/api/admin/notifications/n1/read", payload: { read: "yes" } })).statusCode).toBe(422);
  });
});

describe("Cashier notifications — scoped to the token (D-14, branch isolation)", () => {
  it("lists with cursor pagination and the contract shape; scope comes only from the token", async () => {
    const app = await build({ id: "cashier-1", role: "CASHIER" });
    const res = await app.inject({ method: "GET", url: "/api/notifications?limit=20&status=unread&category=inventory&cashierId=victim&shopId=other" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ nextCursor: null, unreadCount: 3 });
    expect(body.items[0]).toMatchObject({
      id: "n1", category: "inventory", type: "low_stock", severity: "warning", readAt: null,
      recipientCashierId: "cashier-1", shopId: "shop-1", capabilities: { canDelete: true }, target: { kind: "product", id: "p1" },
    });
    expect(last("listCursor")!.args[0]).toBe("cashier-1");
    expect(last("listCursor")!.args[1]).toMatchObject({ status: "unread", category: "INVENTORY" });
  });

  it("date-only from/to are IST days (D-06); malformed bounds are rejected", async () => {
    const app = await build({ id: "cashier-1", role: "CASHIER" });
    await app.inject({ method: "GET", url: "/api/notifications?from=2026-11-05&to=2026-11-05" });
    const range = (last("listCursor")!.args[1] as any).range;
    expect(range.gte.toISOString()).toBe("2026-11-04T18:30:00.000Z");
    expect(range.lt.toISOString()).toBe("2026-11-05T18:30:00.000Z");
    expect((await app.inject({ method: "GET", url: "/api/notifications?from=last-week" })).statusCode).toBe(422);
    expect((await app.inject({ method: "GET", url: "/api/notifications?limit=51" })).statusCode).toBe(422);
  });

  it("an invalid cursor is 400 INVALID_CURSOR", async () => {
    const app = await build({ id: "cashier-1", role: "CASHIER" });
    const res = await app.inject({ method: "GET", url: "/api/notifications?cursor=BAD" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CURSOR");
  });

  it("read-state, delete, acknowledge return the contract bodies (with unreadCount)", async () => {
    const app = await build({ id: "cashier-1", role: "CASHIER" });
    const rs = await app.inject({ method: "PUT", url: "/api/notifications/n1/read-state", payload: { read: true } });
    expect(rs.json()).toMatchObject({ notification: { id: "n1" }, unreadCount: 3 });
    expect(last("setReadState")!.args.slice(0, 3)).toEqual(["cashier-1", "n1", true]);
    expect((await app.inject({ method: "DELETE", url: "/api/notifications/n1" })).json()).toEqual({ id: "n1", unreadCount: 3 });
    const ack = await app.inject({ method: "POST", url: "/api/notifications/n1/acknowledge", headers: { "idempotency-key": "0b6c1a52-2f0a-4c1a-9b53-7e5e3f1d2a10" }, payload: {} });
    expect(ack.json()).toMatchObject({ notification: { id: "n1" }, unreadCount: 3 });
    expect(last("acknowledge")!.args[0]).toBe("cashier-1");
    expect((await app.inject({ method: "GET", url: "/api/notifications/unread-count" })).json()).toEqual({ unreadCount: 3 });
  });

  it("Admins can't use the Cashier endpoints, anonymous gets 401", async () => {
    expect((await (await build({ id: "central-1", role: "ADMIN" })).inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(403);
    expect((await (await build(null)).inject({ method: "GET", url: "/api/notifications" })).statusCode).toBe(401);
  });
});

describe("Notification settings — Security permanently ON (D-07, D-27)", () => {
  it("Cashier GET: five categories; account_security is immutable with a reason", async () => {
    const app = await build({ id: "cashier-1", role: "CASHIER" });
    const { categories } = (await app.inject({ method: "GET", url: "/api/notifications/settings" })).json();
    expect(categories.map((c: any) => c.category)).toEqual(["inventory", "account_security", "session", "announcement", "credit"]);
    const sec = categories.find((c: any) => c.category === "account_security");
    expect(sec).toMatchObject({ enabled: true, mutable: false });
    expect(sec.mandatoryReason).toMatch(/cannot be turned off/);
    expect(categories.find((c: any) => c.category === "inventory")).toMatchObject({ enabled: true, mutable: true });
  });

  it("Cashier PATCH: can switch a normal category off; turning Security off is 403 SETTING_NOT_MUTABLE and stores nothing", async () => {
    const app = await build({ id: "cashier-1", role: "CASHIER" });
    const ok = await app.inject({ method: "PATCH", url: "/api/notifications/settings", payload: { categories: { inventory: false } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().categories.find((c: any) => c.category === "inventory").enabled).toBe(false);

    h.prefs.clear();
    const bad = await app.inject({ method: "PATCH", url: "/api/notifications/settings", payload: { categories: { account_security: false, inventory: false } } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().code).toBe("SETTING_NOT_MUTABLE");
    expect(h.prefs.size).toBe(0);

    const unknown = await app.inject({ method: "PATCH", url: "/api/notifications/settings", payload: { categories: { sales_purchases: false } } });
    expect(unknown.statusCode).toBe(422);
  });

  it("Admin GET/PUT: six categories; PUT of security:false is ignored and security stays ON", async () => {
    const app = await build({ id: "central-1", role: "ADMIN" });
    const get = (await app.inject({ method: "GET", url: "/api/admin/notification-settings" })).json();
    expect(get.categories.map((c: any) => c.category)).toEqual(["inventory", "cashier", "credit", "sales_purchases", "security", "daily_summary"]);
    const put = await app.inject({
      method: "PUT", url: "/api/admin/notification-settings",
      payload: { categories: [{ category: "security", enabled: false }, { category: "credit", enabled: false }] },
    });
    expect(put.statusCode).toBe(200);
    const cats = put.json().categories;
    expect(cats.find((c: any) => c.category === "security")).toMatchObject({ enabled: true, mutable: false });
    expect(cats.find((c: any) => c.category === "credit").enabled).toBe(false);
    expect([...h.prefs.keys()].some((k) => k.endsWith("SECURITY"))).toBe(false);
  });

  it("Admin PUT rejects unknown categories and bad bodies", async () => {
    const app = await build({ id: "central-1", role: "ADMIN" });
    expect((await app.inject({ method: "PUT", url: "/api/admin/notification-settings", payload: { categories: [{ category: "session", enabled: false }] } })).statusCode).toBe(422);
    expect((await app.inject({ method: "PUT", url: "/api/admin/notification-settings", payload: {} })).statusCode).toBe(422);
  });
});
